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

const fs   = require("fs");
const path = require("path");

const STATS_PATH    = path.join(__dirname, ".ai-stats.json");
const MAX_SESSIONS  = 30;
const DEFAULT_TARGET_PH = 10_000_000; // 10M coins/hour

// ── Persistence ────────────────────────────────────────────────────────────────

function loadStats() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATS_PATH, "utf8"));
    if (!raw.items) raw.items = {};
    if (!raw.sessions) raw.sessions = [];
    return raw;
  } catch {
    return { items: {}, sessions: [] };
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

    if (event === "filled") {
      item.fills += 1;
      // Approximate profit: spread captured. We don't know the exact spread here
      // so we track the coins flowing through as a proxy.
      if (pricePerUnit > 0 && amount > 0) {
        // A rough 1% spread estimate when we have price but no explicit profit data.
        item.totalProfitCoins += Math.round(pricePerUnit * amount * 0.01);
      }
    } else if (event === "cancelled") {
      item.cancels += 1;
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
  itemScore,
  isManipulationCoolingDown,
  getSuggestedThresholds,
  getStats,
};
