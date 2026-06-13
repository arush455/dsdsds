const fs = require("fs");
const https = require("https");

const COFL_API_KEY = "YOUR_COFLNET_API_KEY_HERE";
const FILTER_PATH = "./filter.json";

const MIN_PROFIT = 3000;
const MIN_PERCENTAGE = 3;
const MIN_VOLUME = 1000;
const MAX_PRICE = 120000000;

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = { headers: { "Authorization": `Bearer ${COFL_API_KEY}`, ...headers } };
    https.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${data.slice(0, 200)}`)); }
      });
    }).on("error", reject);
  });
}

async function fetchTopFlips() {
  // CoflNet premium flip API — returns top bazaar flips sorted by profit
  const url = "https://sky.coflnet.com/api/flip/bazaar/top?count=50";
  return httpsGet(url);
}

async function updateFilters() {
  console.log(`[${new Date().toISOString()}] Fetching CoflNet top flips...`);

  let flips;
  try {
    flips = await fetchTopFlips();
  } catch (err) {
    console.error("Failed to fetch CoflNet data:", err.message);
    process.exit(1);
  }

  const filter = JSON.parse(fs.readFileSync(FILTER_PATH, "utf8"));
  const blacklist = new Set(filter.blacklist);

  let added = 0;
  let skipped = 0;

  for (const flip of flips) {
    const id = flip.itemId || flip.tag;
    if (!id) continue;
    if (blacklist.has(id)) { skipped++; continue; }

    const profit = flip.profit || flip.medProfit || 0;
    const pct = flip.profitPercentage || flip.medProfitPercentage || 0;
    const buyVol = flip.buyVolume || flip.volume || 0;
    const sellVol = flip.sellVolume || flip.volume || 0;
    const price = flip.buyPrice || flip.price || 0;

    if (profit < MIN_PROFIT) { skipped++; continue; }
    if (pct < MIN_PERCENTAGE) { skipped++; continue; }
    if (buyVol < MIN_VOLUME || sellVol < MIN_VOLUME) { skipped++; continue; }
    if (price > MAX_PRICE) { skipped++; continue; }

    // Already in whitelist — skip
    if (filter.whitelist[id]) { skipped++; continue; }

    filter.whitelist[id] = {
      maxPrice: Math.ceil(price * 1.05),
      minProfit: Math.floor(profit * 0.8),
      minPercentage: Math.max(2, Math.floor(pct * 0.8 * 10) / 10),
      minBuyVolume: Math.floor(buyVol * 0.7),
      minSellVolume: Math.floor(sellVol * 0.7)
    };

    // Also add to selectiveBuys if not present
    if (!filter.selectiveBuys[id]) {
      filter.selectiveBuys[id] = {
        ...filter.whitelist[id],
        relistAfterType: "itemAmount",
        relistAfter: price > 1000000 ? 10 : 128,
        manipulationTriggerPercentage: 2,
        relistWorthThreshold: Math.max(250000, price * 5)
      };
    }

    added++;
    console.log(`  + Added ${id} (profit: ${profit.toLocaleString()}, ${pct.toFixed(1)}%)`);
  }

  fs.writeFileSync(FILTER_PATH, JSON.stringify(filter, null, 2));
  console.log(`Done. Added: ${added}, Skipped: ${skipped}`);
}

updateFilters().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
