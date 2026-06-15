/*
 * webhook-proxy.js — sits between mbf-linux and Discord.
 *
 * - Receives webhooks from mbf-linux on localhost:8765
 * - Parses "Buy Order Placed" and "Sell Offer Placed" worth values
 * - Tracks buy-side and sell-side daily totals (each has a 15B limit)
 * - Kills mbf-linux when either side hits the configured limit (default 13B)
 * - Forwards every webhook to your real Discord URL unchanged
 * - Resets totals automatically at 00:00 UTC
 *
 * Start it before (or alongside) the bot:
 *   node webhook-proxy.js
 *
 * Config lives at the top of this file or in webhook-proxy.config.json.
 */

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

// ── Config ────────────────────────────────────────────────────────────────────

const CFG_PATH = path.join(__dirname, "webhook-proxy.config.json");
let CFG = {
  proxyPort:       8765,
  dailyLimitCoins: 13_000_000_000,   // stop the bot at 13B (2B spare)
  realWebhook:     "",               // filled from config.json automatically
  statePath:       path.join(__dirname, ".proxy-state.json"),
};

try {
  const file = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
  CFG = { ...CFG, ...file };
} catch { /* use defaults */ }

// Pull the real Discord webhook from config.json if not overridden
if (!CFG.realWebhook) {
  try {
    const bot = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
    CFG.realWebhook = bot.webhook || "";
  } catch { /* ignore */ }
}

// ── State (persisted so a proxy restart doesn't reset the counter) ────────────

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // "2026-06-15"
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(CFG.statePath, "utf8"));
    if (s.date === todayUTC()) return s;
  } catch { /* no file yet */ }
  return { date: todayUTC(), buyTotal: 0, sellTotal: 0, stopped: false };
}

function saveState(s) {
  fs.writeFileSync(CFG.statePath, JSON.stringify(s, null, 2));
}

let STATE = loadState();

// Reset at midnight UTC
function scheduleReset() {
  const now  = Date.now();
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  const ms = next.getTime() - now;
  setTimeout(() => {
    STATE = { date: todayUTC(), buyTotal: 0, sellTotal: 0, stopped: false };
    saveState(STATE);
    log("Daily limit reset at 00:00 UTC.");
    scheduleReset();
  }, ms);
}
scheduleReset();

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
}

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toString();
}

// Parse coin strings like "16.14M coins", "308.55K coins", "1.2B coins", "12345 coins"
function parseCoins(str) {
  if (!str) return 0;
  const clean = str.replace(/,/g, "").trim();
  const m = clean.match(/([\d.]+)\s*([KMBkmb])?/);
  if (!m) return 0;
  let val = parseFloat(m[1]);
  if (isNaN(val)) return 0;
  const suffix = (m[2] || "").toUpperCase();
  if (suffix === "K") val *= 1_000;
  if (suffix === "M") val *= 1_000_000;
  if (suffix === "B") val *= 1_000_000_000;
  return Math.round(val);
}

// ── Webhook parsing ───────────────────────────────────────────────────────────

// Returns { type: "buy"|"sell"|null, worth: number }
function extractOrderValue(payload) {
  const embeds = payload.embeds || [];
  for (const embed of embeds) {
    const title = (embed.title || embed.description || "").toLowerCase();
    const isBuy  = title.includes("buy order placed");
    const isSell = title.includes("sell offer placed");
    if (!isBuy && !isSell) continue;

    // Worth lives in embed fields or the description
    const fields = embed.fields || [];
    for (const f of fields) {
      const name = (f.name || "").toLowerCase();
      if (name.includes("worth") || name.includes("value") || name.includes("amount")) {
        const worth = parseCoins(f.value || "");
        if (worth > 0) return { type: isBuy ? "buy" : "sell", worth };
      }
    }

    // Fallback: scrape any coin value from the description
    const desc = embed.description || "";
    const match = desc.match(/([\d.,]+\s*[KMBkmb]?\s*coins)/i);
    if (match) {
      const worth = parseCoins(match[1]);
      if (worth > 0) return { type: isBuy ? "buy" : "sell", worth };
    }
  }
  return { type: null, worth: 0 };
}

// ── Stop the bot ──────────────────────────────────────────────────────────────

function stopBot(reason) {
  if (STATE.stopped) return;
  STATE.stopped = true;
  saveState(STATE);
  log(`LIMIT REACHED — ${reason}. Stopping mbf-linux...`);

  // Notify Discord before killing
  const msg = `🛑 **MBF stopped** — daily limit guard triggered.\n${reason}\nBuy total: **${fmt(STATE.buyTotal)}** | Sell total: **${fmt(STATE.sellTotal)}**\nLimit resets at 00:00 UTC.`;
  forwardToDiscord({ content: msg }).catch(() => {});

  // Give the notification a moment to send, then kill
  setTimeout(() => {
    try {
      // Kill by process name
      const { execSync } = require("child_process");
      execSync("pkill -f mbf-linux", { stdio: "ignore" });
      log("mbf-linux terminated.");
    } catch {
      log("Warning: could not find mbf-linux process to kill. Stop it manually.");
    }
  }, 2000);
}

// ── Forward to Discord ────────────────────────────────────────────────────────

function forwardToDiscord(payload) {
  return new Promise((resolve, reject) => {
    if (!CFG.realWebhook) return resolve();
    let url;
    try { url = new URL(CFG.realWebhook); } catch { return resolve(); }
    const body = JSON.stringify(payload);
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { res.resume(); resolve(); }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(405).end(); return; }

  let body = "";
  req.on("data", c => (body += c));
  req.on("end", async () => {
    res.writeHead(204).end(); // always ack immediately so the bot doesn't hang

    let payload;
    try { payload = JSON.parse(body); } catch { return; }

    // Reload state in case it was manually edited
    STATE = loadState();

    if (!STATE.stopped) {
      const { type, worth } = extractOrderValue(payload);

      if (type === "buy" && worth > 0) {
        STATE.buyTotal += worth;
        saveState(STATE);
        log(`Buy order placed: ${fmt(worth)} | Buy total today: ${fmt(STATE.buyTotal)} / ${fmt(CFG.dailyLimitCoins)}`);
        if (STATE.buyTotal >= CFG.dailyLimitCoins) {
          stopBot(`Buy-side limit hit: ${fmt(STATE.buyTotal)} spent`);
        }
      } else if (type === "sell" && worth > 0) {
        STATE.sellTotal += worth;
        saveState(STATE);
        log(`Sell offer placed: ${fmt(worth)} | Sell total today: ${fmt(STATE.sellTotal)} / ${fmt(CFG.dailyLimitCoins)}`);
        if (STATE.sellTotal >= CFG.dailyLimitCoins) {
          stopBot(`Sell-side limit hit: ${fmt(STATE.sellTotal)} listed`);
        }
      }
    }

    // Always forward to Discord regardless
    try { await forwardToDiscord(payload); } catch { /* non-fatal */ }
  });
});

server.listen(CFG.proxyPort, "127.0.0.1", () => {
  log(`Webhook proxy running on http://127.0.0.1:${CFG.proxyPort}`);
  log(`Daily limit set to ${fmt(CFG.dailyLimitCoins)} (bot stops at this threshold).`);
  log(`Buy total today:  ${fmt(STATE.buyTotal)}`);
  log(`Sell total today: ${fmt(STATE.sellTotal)}`);
  if (!CFG.realWebhook) log("Warning: no Discord webhook URL found — notifications will not be forwarded.");
});

server.on("error", (e) => {
  log(`Server error: ${e.message}`);
  process.exit(1);
});
