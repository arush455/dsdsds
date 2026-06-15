/*
 * cofl-sync.js — auto-update filter.json from the CoflNet (sky.coflnet.com) bazaar flip API.
 *
 * What it does:
 *   - Pulls the live bazaar spread flips from CoflNet.
 *       Premium  : GET /api/flip/bazaar/spread/deemand   (demand-aware, needs your token)
 *       Free     : GET /api/flip/bazaar/spread           (used as fallback)
 *   - Filters them by your thresholds (profit, %, volume, price) and drops manipulated items.
 *   - Writes the qualifying items into filter.json (whitelist + selectiveBuys).
 *   - Leaves your blacklist and your OWN hand-added entries untouched. It only manages the
 *     items it added itself (tracked in .cofl-auto.json) so re-runs stay clean.
 *
 * Zero dependencies — just Node.js. Run:
 *   node cofl-sync.js            # loop forever, refresh every runEveryMinutes
 *   node cofl-sync.js --once     # run a single update and exit (good for cron)
 *   node cofl-sync.js --debug    # print one raw API item so field names can be verified
 *
 * Settings live in cofl-sync.config.json (next to this file).
 */

const fs = require("fs");
const https = require("https");
const path = require("path");

const API_HOST = "sky.coflnet.com";
const PREMIUM_PATH = "/api/flip/bazaar/spread/deemand"; // CoflNet's route is spelled "deemand"
const FREE_PATH = "/api/flip/bazaar/spread";
const CONFIG_PATH = (() => {
  const names = ["cofl-sync.config.json", "coflsync.config.json"];
  for (const n of names) {
    const p = path.join(__dirname, n);
    if (fs.existsSync(p)) return p;
  }
  return path.join(__dirname, "cofl-sync.config.json");
})();
const SIDECAR_PATH = path.join(__dirname, ".cofl-auto.json");

const DEFAULTS = {
  coflToken: "",
  usePremiumDemand: true,
  filterPath: "./filter.json",
  runEveryMinutes: 30,
  maxAutoItems: 40,
  addToWhitelist: true,
  addToSelectiveBuys: true,
  webhook: "",
  thresholds: {
    minProfit: 1000,          // small per-flip spread floor (bazaar flips are tiny per unit)
    minPercentage: 3,         // margin %
    minProfitPerHour: 1000000, // realistic coins/hour per item (premium metric)
    minVolume: 1000,
    maxPrice: 120000000,
    skipManipulated: true,
    relistAfter: 3,           // relist auto items only when pushed past Nth order
  },
};

const ARGS = process.argv.slice(2);
const ONCE = ARGS.includes("--once");
const DEBUG = ARGS.includes("--debug");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function loadConfig() {
  let cfg = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    cfg = { ...DEFAULTS, ...raw, thresholds: { ...DEFAULTS.thresholds, ...(raw.thresholds || {}) } };
  } catch {
    log(`No ${path.basename(CONFIG_PATH)} found — using built-in defaults.`);
  }
  // Fall back to the main bot config's webhook if none set here.
  if (!cfg.webhook) {
    try {
      const botCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
      if (botCfg.webhook) cfg.webhook = botCfg.webhook;
    } catch {
      /* optional */
    }
  }
  return cfg;
}

function httpsGetJson(host, reqPath, token) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: "application/json", "User-Agent": "cofl-sync/1.0" };
    // CoflNet checks GoogleToken header first, then Authorization Bearer as fallback.
    if (token) {
      headers.GoogleToken = token;
      headers.Authorization = `Bearer ${token}`;
    }
    const req = https.request({ host, path: reqPath, method: "GET", headers, timeout: 30000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`), { statusCode: res.statusCode }));
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Could not parse JSON: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

async function fetchFlips(cfg) {
  if (cfg.usePremiumDemand && cfg.coflToken && cfg.coflToken !== "PASTE_YOUR_COFL_TOKEN_HERE") {
    try {
      log("Fetching premium demand-aware bazaar flips...");
      const data = await httpsGetJson(API_HOST, PREMIUM_PATH, cfg.coflToken);
      log("✅ PREMIUM endpoint active (demand-aware data).");
      return data;
    } catch (err) {
      log(`⚠️  Premium endpoint failed (${err.message}). Falling back to the FREE spread endpoint — flip quality will be lower.`);
    }
  } else if (cfg.usePremiumDemand) {
    log("No valid token set — using the free spread endpoint. Add your /cofl api token for premium demand data.");
  }
  log("Fetching free bazaar spread flips...");
  return httpsGetJson(API_HOST, FREE_PATH, cfg.coflToken || null);
}

// Defensive field access — the API wraps each result as { flip: {...}, itemName, isManipulated }.
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function normalize(entry) {
  const flip = entry.flip || entry.Flip || entry;
  const tag = pick(flip, ["itemTag", "ItemTag", "productId", "tag"]) || pick(entry, ["itemTag", "tag"]);
  const buyPrice = Number(pick(flip, ["buyPrice", "BuyPrice", "buy"]) ?? 0);
  const sellPrice = Number(pick(flip, ["sellPrice", "SellPrice", "sell"]) ?? 0);
  const medianValue = Number(pick(flip, ["medianValue", "MedianValue", "medianBuyPrice", "MedianBuyPrice"]) ?? 0);
  // Premium endpoint exposes a single "volume" plus a precomputed coins/hour figure.
  const volume = Number(pick(flip, ["volume", "Volume", "buyVolume", "buyMovingWeek"]) ?? 0);
  const profitPerHour = Number(pick(flip, ["currentProfitPerHour", "CurrentProfitPerHour", "profitPerHour"]) ?? NaN);
  const explicitProfit = Number(pick(flip, ["profit", "Profit", "spread", "Spread"]) ?? NaN);
  // Per-flip profit = spread between sell and buy (the margin you capture once).
  const profit = !Number.isNaN(explicitProfit) ? explicitProfit : Math.abs(sellPrice - buyPrice);
  const isManipulated = Boolean(pick(entry, ["isManipulated", "IsManipulated"]) || pick(flip, ["isManipulated", "IsManipulated"]));
  // Percentage margin on the cost to enter the flip.
  const costBasis = Math.min(buyPrice, sellPrice) || buyPrice || sellPrice;
  const percentage = costBasis > 0 ? (profit / costBasis) * 100 : 0;
  return { tag, buyPrice, sellPrice, medianValue, volume, profit, profitPerHour, percentage, isManipulated };
}

function buildWhitelistEntry(item, t) {
  return {
    maxPrice: Math.min(t.maxPrice, Math.ceil(item.buyPrice * 1.25)),
    minProfit: t.minProfit,
    minPercentage: t.minPercentage,
    minBuyVolume: t.minVolume,
    minSellVolume: t.minVolume,
  };
}

function buildSelectiveEntry(item, t) {
  const p = item.buyPrice;
  // maxBuyAmount scales by price (smaller stacks for expensive items).
  let maxBuyAmount;
  if (p > 5_000_000) maxBuyAmount = 1;
  else if (p > 1_000_000) maxBuyAmount = 5;
  else if (p > 100_000) maxBuyAmount = 64;
  else maxBuyAmount = 2048;
  return {
    ...buildWhitelistEntry(item, t),
    // Relist only when pushed out of the top N orders (let orders sit and fill).
    relistAfterType: "orderAmount",
    relistAfter: typeof t.relistAfter === "number" ? t.relistAfter : 3,
    maxBuyAmount,
    manipulationTriggerPercentage: 2,
    relistWorthThreshold: Math.max(250000, Math.round(p * 5)),
  };
}

function postWebhook(url, content) {
  if (!url) return;
  try {
    const u = new URL(url);
    const body = JSON.stringify({ content });
    const req = https.request(
      { host: u.host, path: u.pathname + u.search, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      () => {}
    );
    req.on("error", () => {});
    req.write(body);
    req.end();
  } catch {
    /* non-fatal */
  }
}

async function runOnce(cfg) {
  const filterPath = path.isAbsolute(cfg.filterPath) ? cfg.filterPath : path.join(__dirname, cfg.filterPath);
  const filter = JSON.parse(fs.readFileSync(filterPath, "utf8"));
  filter.blacklist = filter.blacklist || [];
  filter.whitelist = filter.whitelist || {};
  filter.selectiveBuys = filter.selectiveBuys || {};

  const blacklist = new Set(filter.blacklist);
  const prevAuto = (() => {
    try {
      return new Set(JSON.parse(fs.readFileSync(SIDECAR_PATH, "utf8")).keys || []);
    } catch {
      return new Set();
    }
  })();

  // Remove ONLY the entries we added last time, so manual entries survive.
  for (const key of prevAuto) {
    delete filter.whitelist[key];
    delete filter.selectiveBuys[key];
  }
  // Anything still present is a manual entry we must never overwrite.
  const manualKeys = new Set([...Object.keys(filter.whitelist), ...Object.keys(filter.selectiveBuys)]);

  let raw;
  try {
    raw = await fetchFlips(cfg);
  } catch (err) {
    log(`Failed to fetch CoflNet data: ${err.message}`);
    return;
  }
  if (!Array.isArray(raw)) raw = raw.flips || raw.data || [];
  if (DEBUG && raw.length) {
    log("Raw sample of first API item (verify field names against the parser):");
    console.log(JSON.stringify(raw[0], null, 2));
  }

  const t = cfg.thresholds;
  // Premium gives currentProfitPerHour (coins/hour) directly — the best ranking signal.
  // Fall back to per-flip profit × volume when it's absent (free endpoint).
  const cph = (i) => (!Number.isNaN(i.profitPerHour) ? i.profitPerHour : i.profit * i.volume);
  const minCph = typeof t.minProfitPerHour === "number" ? t.minProfitPerHour : 1_000_000;

  // Funnel diagnostics: count how many items survive each filter stage.
  const funnel = {};
  const stage = (name, arr, pred) => { const out = arr.filter(pred); funnel[name] = `${out.length}/${arr.length}`; return out; };

  let pool = raw.map(normalize).filter((i) => i.tag);
  pool = stage("not-blacklisted", pool, (i) => !blacklist.has(i.tag));
  pool = stage("not-manual",      pool, (i) => !manualKeys.has(i.tag));
  pool = stage("not-manipulated", pool, (i) => !(t.skipManipulated && i.isManipulated));
  pool = stage("minProfit",       pool, (i) => i.profit >= t.minProfit);
  pool = stage("minPercentage",   pool, (i) => i.percentage >= t.minPercentage);
  pool = stage("minProfitPerHour",pool, (i) => cph(i) >= minCph);
  pool = stage("maxPrice",        pool, (i) => i.buyPrice > 0 && i.buyPrice <= t.maxPrice);
  pool = stage("minVolume",       pool, (i) => i.volume >= t.minVolume);
  log(`Filter funnel (survivors/input): ${Object.entries(funnel).map(([k, v]) => `${k} ${v}`).join(" | ")}`);

  const candidates = pool
    // Rank by coins/hour — exactly the metric you care about.
    .sort((a, b) => cph(b) - cph(a))
    .slice(0, cfg.maxAutoItems);

  const newAuto = [];
  for (const item of candidates) {
    if (cfg.addToWhitelist) filter.whitelist[item.tag] = buildWhitelistEntry(item, t);
    if (cfg.addToSelectiveBuys) filter.selectiveBuys[item.tag] = buildSelectiveEntry(item, t);
    newAuto.push(item.tag);
  }

  // Atomic write to avoid the bot reading a half-written file.
  const tmp = filterPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(filter, null, 2));
  fs.renameSync(tmp, filterPath);
  fs.writeFileSync(SIDECAR_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), keys: newAuto }, null, 2));

  const summary = `CoflNet sync: ${newAuto.length} bazaar item(s) auto-listed (from ${raw.length} scanned). Top: ${candidates.slice(0, 5).map((i) => i.tag).join(", ") || "none"}`;
  log(summary);
  postWebhook(cfg.webhook, `🔄 ${summary}`);
}

async function main() {
  const cfg = loadConfig();
  await runOnce(cfg);
  if (ONCE || DEBUG) return;
  const ms = Math.max(1, cfg.runEveryMinutes) * 60 * 1000;
  log(`Looping — next refresh in ${cfg.runEveryMinutes} min. Ctrl+C to stop.`);
  setInterval(() => runOnce(cfg).catch((e) => log(`Run error: ${e.message}`)), ms);
}

main().catch((e) => {
  log(`Fatal: ${e.message}`);
  process.exit(1);
});
