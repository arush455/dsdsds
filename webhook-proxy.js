/*
 * webhook-proxy.js — limit-guard + account orchestrator for MBF.
 *
 * Run this INSTEAD of start.js. It:
 *   1. Reads config.json (the master with the "accounts" array).
 *   2. Launches mbf-linux for ONE enabled account at a time.
 *   3. Receives the bot's webhooks on localhost:<proxyPort>, forwards them to your
 *      real Discord webhook, and tallies each account's buy/sell order totals.
 *   4. When the active account hits the per-account limit (default 13B on buy OR sell),
 *      it stops the bot, marks that account done, and switches to the next enabled
 *      account — giving every account ~2B spare.
 *   5. When all accounts are capped, it idles until 00:00 UTC, then resets and restarts.
 *
 * Start it (single process, replaces start.js):
 *   node webhook-proxy.js
 *
 * Settings: webhook-proxy.config.json  (proxyPort, dailyLimitCoins, realWebhook)
 * Per-account daily progress is saved in .proxy-state.json (survives restarts).
 */

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const { spawn } = require("child_process");

// Accept either filename (with or without the dash) for the shared module.
const _libPath = ["lib-mbf.js", "libmbf.js"]
  .map(n => path.join(__dirname, n))
  .find(p => fs.existsSync(p));
if (!_libPath) {
  console.error("[guard] Missing lib-mbf.js (or libmbf.js) — upload it next to this file.");
  process.exit(1);
}
const { buildRuntimeConfig } = require(_libPath);

// Load ai-advisor if present (accepts both filename spellings).
const _advisorPath = ["ai-advisor.js", "aiadvisor.js"]
  .map(n => path.join(__dirname, n))
  .find(p => fs.existsSync(p));
const advisor = _advisorPath ? require(_advisorPath) : {
  startSession:          () => {},
  recordLimitUsed:       () => {},
  recordWebhookPayload:  () => {},
  recordManipulationFlag: () => {},
};

// ── Config ──────────────────────────────────────────────────────────────────

const CFG_PATH = ["webhook-proxy.config.json", "webhookproxy.config.json"]
  .map(n => path.join(__dirname, n))
  .find(p => fs.existsSync(p)) || path.join(__dirname, "webhook-proxy.config.json");

const MASTER_PATH   = path.join(__dirname, "config.json");
const MASTER_BACKUP = path.join(__dirname, ".config.master.json");
const MBF_BIN       = path.join(__dirname, "mbf-linux");

let CFG = {
  proxyPort:       8765,
  dailyLimitCoins: 13_000_000_000,
  realWebhook:     "",
  statePath:       path.join(__dirname, ".proxy-state.json"),
  restartCrashedAfterSec: 10,
  statusIntervalMinutes: 30,   // how often to post the daily-limit status webhook (0 = off)
};
try { CFG = { ...CFG, ...JSON.parse(fs.readFileSync(CFG_PATH, "utf8")) }; } catch { /* defaults */ }

// Returns the cap for a specific account. Checks accountLimits map first,
// then falls back to the global dailyLimitCoins.
function limitFor(username) {
  if (CFG.accountLimits && CFG.accountLimits[username] !== undefined) {
    return CFG.accountLimits[username];
  }
  return CFG.dailyLimitCoins;
}
// Keep LIMIT as the global default (used for status embed header).
let LIMIT = CFG.dailyLimitCoins;
const PORT  = CFG.proxyPort;

function log(msg) { console.log(`[guard ${new Date().toISOString()}] ${msg}`); }
function isLoopback(url) { return /(^https?:\/\/)?(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url || ""); }
function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return String(n);
}

// ── Load master config (recover if config.json was left as a runtime copy) ────

let masterConfig;
(function loadMaster() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(MASTER_PATH, "utf8")); }
  catch (e) { log(`Cannot read config.json: ${e.message}`); process.exit(1); }

  if (Array.isArray(cfg.accounts)) {
    masterConfig = cfg;
    fs.writeFileSync(MASTER_BACKUP, JSON.stringify(masterConfig, null, 2)); // refresh pristine copy
  } else if (fs.existsSync(MASTER_BACKUP)) {
    log("config.json looks like a leftover runtime copy — recovering master from .config.master.json");
    masterConfig = JSON.parse(fs.readFileSync(MASTER_BACKUP, "utf8"));
    fs.writeFileSync(MASTER_PATH, JSON.stringify(masterConfig, null, 2));
  } else {
    // No accounts array and no backup: run as-is in single-bot (global) mode.
    masterConfig = cfg;
  }
})();

// Real Discord webhook: prefer the proxy config, else the master's webhook.
if (!CFG.realWebhook || isLoopback(CFG.realWebhook)) {
  if (masterConfig.webhook && !isLoopback(masterConfig.webhook)) CFG.realWebhook = masterConfig.webhook;
}
if (isLoopback(CFG.realWebhook)) CFG.realWebhook = "";

// Rotation order: enabled accounts (per-account mode) or a single global run.
const perAccountMode = Array.isArray(masterConfig.accounts);
const rotation = perAccountMode
  ? masterConfig.accounts.filter(a => a.enabled !== false).map(a => a.username)
  : ["__ALL__"];
// All accounts (incl. disabled) — used for the status webhook so disabled ones show "skipped".
const allAccounts = perAccountMode
  ? masterConfig.accounts.map(a => ({ username: a.username, enabled: a.enabled !== false }))
  : [{ username: "__ALL__", enabled: true }];

if (rotation.length === 0) { log("No enabled accounts in config.json. Enable at least one."); process.exit(1); }

// ── Per-account daily state ───────────────────────────────────────────────────

function todayUTC() { return new Date().toISOString().slice(0, 10); }

function freshState() {
  const accounts = {};
  for (const u of rotation) accounts[u] = { buy: 0, sell: 0, profit: 0, done: false };
  return { date: todayUTC(), accounts };
}

let STATE;
(function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(CFG.statePath, "utf8"));
    if (s.date === todayUTC() && s.accounts) {
      STATE = s;
      for (const u of rotation) {
        if (!STATE.accounts[u]) STATE.accounts[u] = { buy: 0, sell: 0, profit: 0, done: false };
        else if (STATE.accounts[u].profit === undefined) STATE.accounts[u].profit = 0;
      }
      return;
    }
  } catch { /* none */ }
  STATE = freshState();
})();

function saveState() { try { fs.writeFileSync(CFG.statePath, JSON.stringify(STATE, null, 2)); } catch {} }
function acc(u) { return (STATE.accounts[u] ||= { buy: 0, sell: 0, profit: 0, done: false }); }

// ── Bot lifecycle ─────────────────────────────────────────────────────────────

let child = null;
let currentAccount = null;
let rotating = false;
let shuttingDown = false;

function restoreMaster() {
  try { fs.writeFileSync(MASTER_PATH, JSON.stringify(masterConfig, null, 2)); } catch {}
}

function spawnBotFor(username) {
  currentAccount = username;
  const opts = { routeWebhook: true, guardPort: PORT };
  if (perAccountMode) opts.onlyAccount = username;
  const { runtime } = buildRuntimeConfig(masterConfig, opts);
  fs.writeFileSync(MASTER_PATH, JSON.stringify(runtime, null, 2));

  advisor.startSession(username);

  const a = acc(username);
  const label = username === "__ALL__" ? "all accounts" : username;
  log(`▶ Launching mbf-linux for ${label} (today: buy ${fmt(a.buy)}, sell ${fmt(a.sell)} / cap ${fmt(limitFor(username))})`);

  child = spawn(MBF_BIN, [], { stdio: ["inherit", "pipe", "inherit"], cwd: __dirname });

  // Forward bot stdout to our own stdout so terminal output is preserved.
  child.stdout.on("data", chunk => {
    process.stdout.write(chunk);
    // Scan for manipulation detection log lines from MBF.
    const text = chunk.toString();
    const manip = /MANIPULATION DETECTED FOR ITEM (\S+)/gi;
    let m;
    while ((m = manip.exec(text)) !== null) {
      advisor.recordManipulationFlag(m[1].toUpperCase());
    }
  });

  child.on("error", (e) => { log(`Failed to launch mbf-linux: ${e.message}`); });

  child.on("exit", (code, signal) => {
    const wasRotating = rotating;
    rotating = false;
    child = null;
    restoreMaster();
    if (shuttingDown) return;
    if (wasRotating) { startNextAccount(); return; }
    // Unexpected exit (crash / manual stop): retry same account unless it's capped.
    if (!acc(username).done) {
      const secs = CFG.restartCrashedAfterSec;
      log(`mbf-linux for ${username} exited (code ${code}${signal ? ", " + signal : ""}). Restarting in ${secs}s...`);
      setTimeout(() => { if (!shuttingDown && !acc(username).done) spawnBotFor(username); }, secs * 1000);
    }
  });
}

function killBotForRotation() {
  if (child && !child.killed) { rotating = true; child.kill("SIGTERM"); }
  else startNextAccount();
}

function startNextAccount() {
  const next = rotation.find(u => !acc(u).done);
  if (!next) {
    log(`✅ All accounts hit their ${fmt(LIMIT)} cap. Idling until 00:00 UTC.`);
    notifyDiscord(`✅ All accounts reached the ${fmt(LIMIT)} daily cap. Pausing until reset (00:00 UTC).`);
    restoreMaster();
    return;
  }
  spawnBotFor(next);
}

function capCurrentAndRotate(reason) {
  const u = currentAccount;
  acc(u).done = true;
  saveState();
  const label = u === "__ALL__" ? "Bot" : u;
  log(`🧯 ${label} reached cap (${reason}). Profit today: ${fmt(acc(u).profit)}. ${perAccountMode ? "Switching account." : "Stopping."}`);
  notifyDiscord(`🧯 **${label}** hit the ${fmt(LIMIT)} cap (${reason}).\n💰 Profit today: **${fmt(acc(u).profit)}**${perAccountMode ? "\nSwitching to the next account." : "\nStopping until 00:00 UTC."}`);
  postStatus();
  killBotForRotation();
}

// ── Webhook parsing ───────────────────────────────────────────────────────────

function parseCoins(str) {
  const m = String(str || "").replace(/,/g, "").trim().match(/([\d.]+)\s*([KMBkmb])?/);
  if (!m) return 0;
  let v = parseFloat(m[1]); if (isNaN(v)) return 0;
  const s = (m[2] || "").toUpperCase();
  if (s === "K") v *= 1e3; if (s === "M") v *= 1e6; if (s === "B") v *= 1e9;
  return Math.round(v);
}

function extractProfit(payload) {
  for (const embed of payload.embeds || []) {
    for (const f of embed.fields || []) {
      const name = (f.name || "").toLowerCase();
      if (name.includes("profit")) {
        const p = parseCoins(f.value);
        if (p > 0) return p;
      }
    }
  }
  return 0;
}

function extractOrderValue(payload) {
  for (const embed of payload.embeds || []) {
    const rawTitle = embed.title || embed.description || "";
    const title = rawTitle.toLowerCase();
    // Log first embed title so we can verify format matches
    if (rawTitle) log(`[webhook] embed title: "${rawTitle.slice(0, 120)}"`);

    const isBuy  = title.includes("buy order") || title.includes("buy offer");
    const isSell = title.includes("sell offer") || title.includes("sell order");
    if (!isBuy && !isSell) continue;

    for (const f of embed.fields || []) {
      const name = (f.name || "").toLowerCase();
      log(`[webhook] field: "${f.name}" = "${(f.value || "").slice(0, 60)}"`);
      if (name.includes("worth") || name.includes("value") || name.includes("amount") || name.includes("coin") || name.includes("price") || name.includes("total")) {
        const w = parseCoins(f.value);
        if (w > 0) return { type: isBuy ? "buy" : "sell", worth: w };
      }
    }
    // Fallback: scan description for any coin amount
    const desc = embed.description || "";
    const m = desc.match(/([\d.,]+\s*[KMBkmb]?)\s*coins/i);
    if (m) { const w = parseCoins(m[1]); if (w > 0) return { type: isBuy ? "buy" : "sell", worth: w }; }
    // Last fallback: any large number in description (likely order value)
    const m2 = desc.match(/([\d.,]{4,})/);
    if (m2) { const w = parseCoins(m2[1]); if (w > 50000) return { type: isBuy ? "buy" : "sell", worth: w }; }
  }
  return { type: null, worth: 0 };
}

function recordOrder(type, worth) {
  if (!currentAccount) return;
  const a = acc(currentAccount);
  if (a.done) return;
  if (type === "buy") a.buy += worth; else a.sell += worth;
  advisor.recordLimitUsed(worth);
  saveState();
  const label = currentAccount === "__ALL__" ? "ALL" : currentAccount;
  const total = a.buy + a.sell;
  const cap = limitFor(currentAccount);
  log(`${type === "buy" ? "Buy " : "Sell"} ${fmt(worth)} | ${label}: total ${fmt(total)} (buy ${fmt(a.buy)} + sell ${fmt(a.sell)}) / cap ${fmt(cap)}`);
  if (total >= cap) {
    capCurrentAndRotate(`total ${fmt(total)} = buy ${fmt(a.buy)} + sell ${fmt(a.sell)}`);
  }
}

// ── Discord forwarding ────────────────────────────────────────────────────────

function forwardToDiscord(payload) {
  return new Promise((resolve) => {
    if (!CFG.realWebhook) return resolve();
    let url; try { url = new URL(CFG.realWebhook); } catch { return resolve(); }
    const body = JSON.stringify(payload);
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { res.resume(); resolve(); }
    );
    req.on("error", () => resolve());
    req.write(body); req.end();
  });
}
function notifyDiscord(content) { forwardToDiscord({ content }).catch(() => {}); }

// ── Daily-limit status webhook ────────────────────────────────────────────────

function bar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
}

function buildStatusEmbed() {
  const fields = allAccounts.map(({ username: u, enabled }) => {
    const label = u === "__ALL__" ? "All accounts" : u;
    // Disabled accounts: show as skipped, no progress bar.
    if (!enabled) {
      return { name: `${label} ⏭️ skipped`, value: "_disabled in config_" };
    }
    const a = acc(u);
    const total = a.buy + a.sell;
    const acap = limitFor(u);
    const tp = acap ? (total / acap) * 100 : 0;
    const tag = (u === currentAccount && child) ? " 🟢 active" : (a.done ? " ✅ capped" : "");
    return {
      name: `${label}${tag}`,
      value:
        `\`${bar(tp)}\` **${fmt(total)} / ${fmt(acap)}** (${tp.toFixed(0)}%)\n` +
        `└ buy ${fmt(a.buy)} · sell ${fmt(a.sell)}`,
    };
  });
  return {
    title: "📊 MBF Daily Limit Status",
    description: `Per-account cap **${fmt(LIMIT)}** (buy + sell combined) · resets 00:00 UTC`,
    color: 0xa78bfa,
    fields,
    footer: { text: child ? `Active: ${currentAccount}` : "Idle (all capped / waiting)" },
    timestamp: new Date().toISOString(),
  };
}

function logStatus() {
  log("─── Daily limit status ───");
  for (const { username: u, enabled } of allAccounts) {
    const label = u === "__ALL__" ? "All accounts" : u;
    if (!enabled) { log(`  • ${label}: ⏭️  SKIPPED (disabled in config)`); continue; }
    const a = acc(u);
    const total = a.buy + a.sell;
    const acap = limitFor(u);
    const pct = acap ? ((total / acap) * 100).toFixed(0) : 0;
    const tag = (u === currentAccount && child) ? "🟢 active" : (a.done ? "✅ capped" : "idle");
    log(`  • ${label}: ${tag} | ${fmt(total)} / ${fmt(acap)} (${pct}%) | buy ${fmt(a.buy)} + sell ${fmt(a.sell)}`);
  }
}

function postStatus() {
  logStatus();
  if (CFG.realWebhook) forwardToDiscord({ embeds: [buildStatusEmbed()] }).catch(() => {});
}

// ── Midnight reset ────────────────────────────────────────────────────────────

function scheduleReset() {
  const next = new Date(); next.setUTCHours(24, 0, 0, 0);
  setTimeout(() => {
    STATE = freshState(); saveState();
    log(`Daily limits reset (00:00 UTC).`);
    notifyDiscord("🔄 Daily limits reset. Resuming flipping.");
    if (!child) startNextAccount(); // resume if we were idle
    scheduleReset();
  }, next.getTime() - Date.now());
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", async () => {
    res.writeHead(204).end();
    let payload; try { payload = JSON.parse(body); } catch { return; }
    const { type, worth } = extractOrderValue(payload);
    if (type && worth > 0) recordOrder(type, worth);
    const profit = extractProfit(payload);
    if (profit > 0 && currentAccount) { acc(currentAccount).profit += profit; saveState(); }
    forwardToDiscord(payload);
    advisor.recordWebhookPayload(payload);
  });
});

// ── Shutdown handling ─────────────────────────────────────────────────────────

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${sig} — stopping bot and restoring config...`);
  if (currentAccount) {
    const label = currentAccount === "__ALL__" ? "Bot" : currentAccount;
    const p = acc(currentAccount).profit;
    log(`💰 Profit today (${label}): ${fmt(p)}`);
    notifyDiscord(`🛑 **${label}** stopped (${sig}).\n💰 Profit today: **${fmt(p)}**`);
  }
  if (child && !child.killed) child.kill("SIGTERM");
  setTimeout(() => { restoreMaster(); process.exit(0); }, 1500);
}
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => shutdown(s));
process.on("exit", () => { if (!child) restoreMaster(); });

// ── Go ──────────────────────────────────────────────────────────────────────

server.listen(PORT, "127.0.0.1", () => {
  log(`Limit guard on http://127.0.0.1:${PORT} | mode: ${perAccountMode ? "per-account rotation" : "single/global"}`);
  log(`Rotation order: ${rotation.join(" -> ")}`);
  // Per-account overview in the terminal (incl. skipped/disabled accounts).
  for (const { username: u, enabled } of allAccounts) {
    const label = u === "__ALL__" ? "All accounts" : u;
    if (!enabled) { log(`  • ${label}: ⏭️  SKIPPED (disabled in config)`); continue; }
    const a = acc(u);
    log(`  • ${label}: cap ${fmt(limitFor(u))} | today buy ${fmt(a.buy)} + sell ${fmt(a.sell)}${a.done ? " | ✅ capped" : ""}`);
  }
  if (!CFG.realWebhook) log("Warning: no Discord webhook found — order webhooks won't be forwarded.");
  const allDone = rotation.every(u => acc(u).done);
  if (allDone) { log("All accounts already capped for today. Idling until 00:00 UTC."); restoreMaster(); }
  else startNextAccount();
  scheduleReset();

  // Periodic daily-limit status webhook (plus one shortly after startup).
  const statusMin = CFG.statusIntervalMinutes;
  if (statusMin > 0 && CFG.realWebhook) {
    setTimeout(postStatus, 20000);
    setInterval(postStatus, statusMin * 60 * 1000);
    log(`Status webhook every ${statusMin} min.`);
  }
});
server.on("error", (e) => { log(`Server error: ${e.message}`); process.exit(1); });
