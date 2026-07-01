/*
 * ai-advisor.js — item scoring, dynamic threshold tuning, and manipulation memory.
 *
 * Pure Node.js, no external dependencies.
 * Data persisted to .ai-stats.json next to this file.
 *
 * Exports:
 *   recordWebhookPayload(payload)   — called by webhook-proxy for every webhook
 *   recordManipulationFlag(tag)     — called by webhook-proxy when MBF manipulation log detected
 *   startSession(username)          — called by webhook-proxy when bot launches for an account
 *   recordLimitUsed(worth)          — called by webhook-proxy on each order
 *   itemScore(tag)                  — used by cofl-sync to rank items
 *   isManipulationCoolingDown(tag)  — used by cofl-sync to skip items in cooldown
 *   getSuggestedThresholds(cfg)     — used by cofl-sync to auto-tune thresholds
 *   getStats()                      — returns full stats object (for debugging)
 */

"use strict";

const fs    = require("fs");
const path  = require("path");
const https = require("https");

const STATS_PATH    = path.join(__dirname, ".ai-stats.json");
const MAX_SESSIONS  = 30;
const DEFAULT_TARGET_PH = 10_000_000; // 10M coins/hour

const ADVISOR_CFG_PATH = path.join(__dirname, "ai-advisor.config.json");
function loadAdvisorConfig() {
  try { return JSON.parse(fs.readFileSync(ADVISOR_CFG_PATH, "utf8")); }
  catch { return { enabled: false }; }
}

// Safety bounds: the model may only suggest values inside these ranges,
// and only for these specific keys. Anything else is ignored.
const TUNABLE_BOUNDS = {
  "profit.minPercentage":               [2, 10],
  "profit.min":                         [50000, 1000000],
  "orders.maxBuyOrders":                [3, 12],
  "orders.relistAfter":                 [1, 5],
  "volume.minBuy":                      [500, 8000],
  "volume.minSell":                     [500, 8000],
  "purse.maxSpentPerOrder":             [50000000, 400000000],
  "price.manipulationTriggerPercentage": [3, 15],
};

function getAt(obj, dottedKey) {
  return dottedKey.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setAt(obj, dottedKey, value) {
  const parts = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = cur[parts[i]] || {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
function clamp(v, [lo, hi]) { return Math.max(lo, Math.min(hi, v)); }

function callClaude(apiKey, model, systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`Claude API ${res.statusCode}: ${data.slice(0, 300)}`));
          try {
            const parsed = JSON.parse(data);
            const text = (parsed.content || []).map(b => b.text || "").join("");
            resolve(text);
          } catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function extractJson(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ── 4. Full-config AI tuning via the real Claude API ──────────────────────────
//
// Called after each session ends. Sends recent stats + current tunable config
// values to Claude, asks for adjustments, applies anything within bounds.

// Writes updated tunables into master + cofl config files (atomic tmp+rename).
function writeTunables(masterConfigPath, masterConfig, coflConfigPath, coflConfig) {
  try {
    fs.writeFileSync(masterConfigPath + ".tmp", JSON.stringify(masterConfig, null, 2));
    fs.renameSync(masterConfigPath + ".tmp", masterConfigPath);
  } catch {}
  if (coflConfig && coflConfigPath) {
    try {
      fs.writeFileSync(coflConfigPath + ".tmp", JSON.stringify(coflConfig, null, 2));
      fs.renameSync(coflConfigPath + ".tmp", coflConfigPath);
    } catch {}
  }
}

function applyUpdates(updates, masterConfig, coflConfig) {
  const applied = {};
  for (const [key, bounds] of Object.entries(TUNABLE_BOUNDS)) {
    if (!(key in updates)) continue;
    const raw = Number(updates[key]);
    if (Number.isNaN(raw)) continue;
    const safe = clamp(raw, bounds);
    setAt(masterConfig, key, safe);
    if (coflConfig && key === "profit.minPercentage") setAt(coflConfig, "thresholds.minPercentage", safe);
    if (coflConfig && key === "orders.relistAfter") setAt(coflConfig, "thresholds.relistAfter", safe);
    applied[key] = safe;
  }
  return applied;
}

async function consultAndTune({ masterConfigPath, coflConfigPath } = {}) {
  const advisorCfg = loadAdvisorConfig();
  if (!advisorCfg.enabled || !advisorCfg.anthropicApiKey) return null;

  let masterConfig, coflConfig;
  try { masterConfig = JSON.parse(fs.readFileSync(masterConfigPath, "utf8")); } catch { return null; }
  try { coflConfig = coflConfigPath ? JSON.parse(fs.readFileSync(coflConfigPath, "utf8")) : null; } catch { coflConfig = null; }

  const currentTunables = {};
  for (const key of Object.keys(TUNABLE_BOUNDS)) {
    const v = getAt(masterConfig, key);
    if (v !== undefined) currentTunables[key] = v;
  }

  const now = Date.now();
  const lastTune = _stats.tuningLog[_stats.tuningLog.length - 1];

  // ── Auto-rollback: if the last change produced ZERO fills for too long, revert it ──
  const rollbackAfterMin = advisorCfg.rollbackAfterMinutes || 45;
  if (lastTune && !lastTune.rolledBack && lastTune.before) {
    const elapsedMin = (now - new Date(lastTune.at).getTime()) / 60000;
    const fillsSince = _stats.totalFills - (lastTune.fillsAtChange || 0);
    if (elapsedMin >= rollbackAfterMin && fillsSince === 0) {
      const reverted = applyUpdates(lastTune.before, masterConfig, coflConfig);
      writeTunables(masterConfigPath, masterConfig, coflConfigPath, coflConfig);
      lastTune.rolledBack = true;
      saveStats(_stats);
      return {
        applied: reverted,
        reasoning: `AUTO-ROLLBACK: ${Math.round(elapsedMin)} min with zero fills since last tuning — reverted to previous values.`,
      };
    }
  }

  // ── Ping-pong guard: don't re-tune too soon after the last applied change ──
  const cooldownMin = advisorCfg.minMinutesBetweenChanges || 90;
  if (lastTune && !lastTune.rolledBack) {
    const elapsedMin = (now - new Date(lastTune.at).getTime()) / 60000;
    const fillsSince = _stats.totalFills - (lastTune.fillsAtChange || 0);
    // Allow early re-tune only in the zero-fill emergency case (handled above once
    // rollbackAfterMinutes is reached); otherwise wait out the cooldown.
    if (elapsedMin < cooldownMin && fillsSince > 0) {
      return { error: `cooldown: last change ${Math.round(elapsedMin)} min ago (< ${cooldownMin} min), letting it play out` };
    }
    if (elapsedMin < Math.min(cooldownMin, rollbackAfterMin) && fillsSince === 0) {
      return { error: `cooldown: last change ${Math.round(elapsedMin)} min ago, waiting to see fills before re-tuning` };
    }
  }

  const recentSessions = _stats.sessions.slice(-10);

  // Tuning history with measured outcomes, so the model can learn what worked.
  const tuningHistory = _stats.tuningLog.slice(-5).map(t => ({
    at: t.at,
    changes: t.applied,
    reasoning: t.reasoning,
    rolledBack: !!t.rolledBack,
    outcomeSince: {
      fills: _stats.totalFills - (t.fillsAtChange || 0),
      profitCoins: (_stats.totalProfit || 0) - (t.profitAtChange || 0),
    },
  }));
  const topItems = Object.entries(_stats.items)
    .sort((a, b) => (b[1].fills - b[1].cancels) - (a[1].fills - a[1].cancels))
    .slice(0, 15)
    .map(([tag, s]) => ({ tag, fills: s.fills, cancels: s.cancels, manipulationFlags: s.manipulationFlags }));

  const systemPrompt =
    "You are an autonomous tuning advisor for a Hypixel SkyBlock bazaar flipping bot. " +
    "You will be given recent session stats, item fill/cancel data, and the bot's current tunable settings. " +
    "Your job: suggest small, safe adjustments to maximize total daily profit while minimizing how long the bot " +
    "needs to run per day (shorter runtime = lower ban risk) and avoiding manipulated items. " +
    "Exact semantics of each key — read carefully, the direction matters: " +
    "'price.manipulationTriggerPercentage' is how big a price swing (%) must be before an item is FLAGGED as manipulated and blocked. " +
    "LOWERING it makes detection MORE sensitive and blocks MORE items (including legitimate ones) — this is the opposite of 'tightening' filters for quality. " +
    "If zero/low fills are caused by too many items being blocked, RAISE this value, do not lower it. " +
    "Only lower it if you see evidence of actual manipulation losses slipping through. " +
    "'volume.minBuy'/'volume.minSell' raise the liquidity bar — raising them REDUCES the number of eligible items, which can also cause zero fills if set too high. " +
    "'profit.minPercentage' raising it makes the bot pickier (fewer but bigger-margin trades); lowering it allows more trades. " +
    "If recent sessions show zero or near-zero fills, treat that as a sign your filters are TOO STRICT, not too loose — your default response should be to loosen (raise manipulationTriggerPercentage, lower volume minimums, lower minPercentage), not tighten further. " +
    "You are also given 'tuningHistory': your own previous changes with the measured outcome since each change (fills and profitCoins). " +
    "USE IT: if a past change was followed by good fills/profit, keep or extend that direction; if it was followed by poor results or was rolled back, do not repeat it. " +
    "If the current settings are performing well (steady fills, positive profit), it is perfectly fine to change NOTHING — respond with an empty updates object. " +
    "Never simply reverse your own previous change without new evidence (no ping-ponging). " +
    "Only suggest values for the exact keys given to you, never invent new keys. " +
    "Respond with ONLY a JSON object: {\"updates\": {\"<key>\": <value>, ...}, \"reasoning\": \"<one short sentence>\"}. " +
    "Make conservative, incremental changes — do not swing values drastically between calls.";

  const userPrompt = JSON.stringify({
    currentTunables,
    boundsForEachKey: TUNABLE_BOUNDS,
    recentSessions,
    tuningHistory,
    lifetime: { totalFills: _stats.totalFills, totalProfitCoins: _stats.totalProfit },
    topItemsByFillCancelMargin: topItems,
  }, null, 2);

  let reply;
  try {
    reply = await callClaude(advisorCfg.anthropicApiKey, advisorCfg.model || "claude-opus-4-8", systemPrompt, userPrompt);
  } catch (e) {
    return { error: e.message };
  }

  const parsed = extractJson(reply);
  if (!parsed || !parsed.updates) return { error: "no JSON in reply", raw: reply };

  // Snapshot current values of the keys the model wants to change (for rollback).
  const before = {};
  for (const key of Object.keys(TUNABLE_BOUNDS)) {
    if (key in parsed.updates && key in currentTunables) before[key] = currentTunables[key];
  }

  const applied = applyUpdates(parsed.updates, masterConfig, coflConfig);

  // Drop no-op "changes" (same value as before) so they don't reset the cooldown.
  for (const [k, v] of Object.entries(applied)) {
    if (before[k] === v) { delete applied[k]; delete before[k]; }
  }

  if (Object.keys(applied).length) {
    writeTunables(masterConfigPath, masterConfig, coflConfigPath, coflConfig);
    _stats.tuningLog.push({
      at: new Date().toISOString(),
      applied,
      before,
      reasoning: parsed.reasoning || "",
      fillsAtChange: _stats.totalFills,
      profitAtChange: _stats.totalProfit || 0,
      rolledBack: false,
    });
    if (_stats.tuningLog.length > 20) _stats.tuningLog = _stats.tuningLog.slice(-20);
    saveStats(_stats);
  }

  return { applied, reasoning: parsed.reasoning || "" };
}

// ── Persistence ────────────────────────────────────────────────────────────────

function loadStats() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATS_PATH, "utf8"));
    if (!raw.items) raw.items = {};
    if (!raw.sessions) raw.sessions = [];
    if (!raw.tuningLog) raw.tuningLog = [];
    if (typeof raw.totalFills !== "number") raw.totalFills = 0;
    if (typeof raw.totalProfit !== "number") raw.totalProfit = 0;
    return raw;
  } catch {
    return { items: {}, sessions: [], tuningLog: [], totalFills: 0, totalProfit: 0 };
  }
}

function saveStats(stats) {
  const tmp = STATS_PATH + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, STATS_PATH);
  } catch (e) {
    // Best-effort; non-fatal
    try { fs.unlinkSync(tmp); } catch {}
  }
}

let _stats = loadStats();

function ensureItem(tag) {
  if (!_stats.items[tag]) {
    _stats.items[tag] = {
      fills: 0,
      cancels: 0,
      totalProfitCoins: 0,
      manipulationFlags: 0,
      lastManipulationAt: null,
      lastSeen: null,
    };
  }
  return _stats.items[tag];
}

// ── Display name → item tag normalizer ────────────────────────────────────────

function displayNameToTag(name) {
  // e.g. "Enchanted Wheat" → "ENCHANTED_WHEAT"
  return String(name || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/[^A-Z0-9_]/g, "");
}

// ── Webhook payload parsing ───────────────────────────────────────────────────
//
// MBF Discord webhooks have embeds with title/description/fields.
// We try to extract: item display name, event type, order type, amount, price-per-unit.
//
// Common embed title formats (approximate):
//   "Buy Order Placed — Enchanted Wheat"
//   "Sell Offer Filled — Diamond x64 @ 250 each"
//   "Buy Order Cancelled — ENCHANTED_WHEAT"

const EVENT_PATTERNS = [
  { re: /placed/i,    event: "placed"    },
  { re: /filled/i,    event: "filled"    },
  { re: /cancelled/i, event: "cancelled" },
  { re: /canceled/i,  event: "cancelled" },
];

const ORDER_PATTERNS = [
  { re: /buy/i,  order: "buy"  },
  { re: /sell/i, order: "sell" },
];

function parseCoins(str) {
  const m = String(str || "").replace(/,/g, "").trim().match(/([\d.]+)\s*([KMBkmb])?/);
  if (!m) return 0;
  let v = parseFloat(m[1]); if (isNaN(v)) return 0;
  const s = (m[2] || "").toUpperCase();
  if (s === "K") v *= 1e3;
  if (s === "M") v *= 1e6;
  if (s === "B") v *= 1e9;
  return Math.round(v);
}

function extractItemName(text) {
  // Try "— Item Name" or ": Item Name" after the order type keyword
  let m = text.match(/(?:order|offer)\s+(?:placed|filled|cancelled|canceled)\s*[—\-:]\s*(.+)/i);
  if (m) return m[1].trim().split(/\s+x\d+/i)[0].trim();
  // Try anything after the last dash/colon
  m = text.match(/[—\-:]\s*([A-Za-z][A-Za-z0-9 _]+)/);
  if (m) return m[1].trim();
  return null;
}

function parseMbfEmbed(embed) {
  const rawTitle = embed.title || embed.description || "";
  if (!rawTitle) return null;

  // Detect event type
  let event = null;
  for (const p of EVENT_PATTERNS) {
    if (p.re.test(rawTitle)) { event = p.event; break; }
  }
  if (!event) return null;

  // Detect order type
  let orderType = null;
  for (const p of ORDER_PATTERNS) {
    if (p.re.test(rawTitle)) { orderType = p.order; break; }
  }

  // Extract item display name
  const displayName = extractItemName(rawTitle);
  if (!displayName) return null;
  const tag = displayNameToTag(displayName);
  if (!tag) return null;

  // Try to extract amount and price-per-unit from fields
  let amount = 0;
  let pricePerUnit = 0;
  for (const f of embed.fields || []) {
    const fname = (f.name || "").toLowerCase();
    const fval  = f.value || "";
    if (fname.includes("amount") || fname.includes("qty") || fname.includes("quantity")) {
      const n = parseFloat(fval.replace(/,/g, "")); if (!isNaN(n)) amount = n;
    }
    if (fname.includes("price") && !fname.includes("total")) {
      pricePerUnit = parseCoins(fval);
    }
  }

  return { tag, displayName, event, orderType, amount, pricePerUnit };
}

// ── 1. Item performance tracking ──────────────────────────────────────────────

function recordWebhookPayload(payload) {
  if (!payload || !Array.isArray(payload.embeds)) return;
  const now = new Date().toISOString();

  for (const embed of payload.embeds) {
    const parsed = parseMbfEmbed(embed);
    if (!parsed) continue;

    const { tag, event, pricePerUnit, amount } = parsed;
    const item = ensureItem(tag);
    item.lastSeen = now;

    const session = _stats.sessions[_stats.sessions.length - 1];
    if (event === "filled") {
      item.fills += 1;
      _stats.totalFills += 1;
      if (session) session.fills = (session.fills || 0) + 1;
      // Approximate profit: spread captured. We don't know the exact spread here
      // so we track the coins flowing through as a proxy.
      if (pricePerUnit > 0 && amount > 0) {
        // A rough 1% spread estimate when we have price but no explicit profit data.
        item.totalProfitCoins += Math.round(pricePerUnit * amount * 0.01);
      }
    } else if (event === "cancelled") {
      item.cancels += 1;
      if (session) session.cancels = (session.cancels || 0) + 1;
    }
    // "placed" is informational — we just update lastSeen (already done above)
  }

  saveStats(_stats);
}

// ── Item score ─────────────────────────────────────────────────────────────────
//
// fillRate = fills / (fills + cancels)
// score    = fillRate * log(fills + 1), clamped [0.1, 2.0]
// New items (no data): 1.0
// >70% fill rate + 5+ fills → score > 1.0
// <30% fill rate or 3+ manipulation flags → score < 0.5

function itemScore(tag) {
  const item = _stats.items[tag];
  if (!item) return 1.0; // neutral default

  const { fills, cancels, manipulationFlags } = item;
  const total = fills + cancels;

  // Force low score for heavily manipulated items
  if (manipulationFlags >= 3) return 0.1;

  if (total === 0) return 1.0;

  const fillRate = fills / total;

  // Force low score for very poor performers or manipulated items
  if (fillRate < 0.30 || manipulationFlags >= 3) {
    return Math.max(0.1, fillRate * Math.log(fills + 1));
  }

  const raw = fillRate * Math.log(fills + 1);

  // Clamp to [0.1, 2.0]
  return Math.max(0.1, Math.min(2.0, raw));
}

// ── 2. Dynamic threshold tuning ───────────────────────────────────────────────

function startSession(username) {
  const session = {
    date:       new Date().toISOString().slice(0, 10),
    username:   username || "unknown",
    startTime:  new Date().toISOString(),
    profitCoins: 0,
    limitUsed:   0,
  };
  _stats.sessions.push(session);
  // Rolling window: keep only the last MAX_SESSIONS sessions
  if (_stats.sessions.length > MAX_SESSIONS) {
    _stats.sessions = _stats.sessions.slice(-MAX_SESSIONS);
  }
  saveStats(_stats);
}

function recordLimitUsed(worth) {
  if (!_stats.sessions.length) return;
  const current = _stats.sessions[_stats.sessions.length - 1];
  current.limitUsed = (current.limitUsed || 0) + (worth || 0);
  saveStats(_stats);
}

function recordProfit(coins) {
  if (!_stats.sessions.length || !coins) return;
  const current = _stats.sessions[_stats.sessions.length - 1];
  current.profitCoins = (current.profitCoins || 0) + coins;
  _stats.totalProfit = (_stats.totalProfit || 0) + coins;
  saveStats(_stats);
}

function getSuggestedThresholds(currentConfig) {
  const cfg    = currentConfig || {};
  const target = cfg.targetProfitPerHour || DEFAULT_TARGET_PH;

  // Compute rolling avg P/H from last 5 completed sessions
  const recent = _stats.sessions.slice(-5);
  if (recent.length < 2) return { ...cfg }; // not enough data yet

  // Estimate P/H per session: profitCoins / session_hours
  const phs = recent.map(s => {
    const hours = s.limitUsed > 0
      ? s.limitUsed / 13_000_000_000 * 24 // rough: fraction of daily limit used × 24h
      : 1;
    return (s.profitCoins || 0) / Math.max(hours, 0.1);
  });
  const avgPh = phs.reduce((a, b) => a + b, 0) / phs.length;

  let minPercentage = typeof cfg.minPercentage === "number" ? cfg.minPercentage : 3;

  if (avgPh > target * 1.2) {
    minPercentage = Math.min(6, minPercentage + 0.25);
  } else if (avgPh < target * 0.8) {
    minPercentage = Math.max(2, minPercentage - 0.25);
  }

  return { ...cfg, minPercentage };
}

// ── 3. Manipulation memory ────────────────────────────────────────────────────

const COOLDOWN_TABLE = [
  0,                    // 0 flags  → 0ms
  2 * 60 * 60 * 1000,  // 1 flag   → 2 hours
  6 * 60 * 60 * 1000,  // 2 flags  → 6 hours
  24 * 60 * 60 * 1000, // 3+ flags → 24 hours
];

function recordManipulationFlag(tag) {
  if (!tag) return;
  const item = ensureItem(tag);
  item.manipulationFlags = (item.manipulationFlags || 0) + 1;
  item.lastManipulationAt = new Date().toISOString();
  saveStats(_stats);
}

function getManipulationCooldownMs(tag) {
  const item = _stats.items[tag];
  if (!item) return 0;
  const flags = item.manipulationFlags || 0;
  if (flags === 0) return 0;
  const idx = Math.min(flags, COOLDOWN_TABLE.length - 1);
  return COOLDOWN_TABLE[idx];
}

function isManipulationCoolingDown(tag) {
  const item = _stats.items[tag];
  if (!item || !item.lastManipulationAt) return false;
  const cooldownMs = getManipulationCooldownMs(tag);
  if (cooldownMs === 0) return false;
  const elapsed = Date.now() - new Date(item.lastManipulationAt).getTime();
  return elapsed < cooldownMs;
}

// ── Exports ───────────────────────────────────────────────────────────────────

function getStats() {
  return _stats;
}

module.exports = {
  recordWebhookPayload,
  recordManipulationFlag,
  startSession,
  recordLimitUsed,
  recordProfit,
  itemScore,
  isManipulationCoolingDown,
  getSuggestedThresholds,
  consultAndTune,
  getStats,
};
