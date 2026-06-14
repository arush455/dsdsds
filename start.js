/*
 * start.js — MBF launcher with per-account enable/disable support.
 *
 * Usage:
 *   node start.js          # normal launch
 *   node start.js --dry    # print the runtime config without starting the bot (for testing)
 *
 * How to toggle accounts in config.json:
 *
 *   "selectiveAccountSwitch": true,       <- set false to disable the feature entirely (all accounts used)
 *   "accounts": [
 *     { "username": "MainAcc",   "enabled": false },   <- skipped
 *     { "username": "BotAcc",    "enabled": true  },   <- active
 *     { "username": "ThirdAcc",  "enabled": true  }    <- active
 *   ]
 *
 * Proxy arrays are automatically re-indexed to match the filtered account list,
 * so proxy[0] always maps to the first ENABLED account.
 *
 * When selectiveAccountSwitch is false or the "accounts" key is absent,
 * the launcher passes config.json to mbf-linux unchanged.
 */

const fs   = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const CONFIG_PATH  = path.join(__dirname, "config.json");
const RUNTIME_PATH = path.join(__dirname, ".config.runtime.json");
const MBF_BIN      = path.join(__dirname, "mbf-linux");
const DRY          = process.argv.includes("--dry");

function log(msg) {
  console.log(`[start.js] ${msg}`);
}

function buildRuntimeConfig(cfg) {
  // Feature disabled or no accounts array — nothing to do.
  if (!cfg.selectiveAccountSwitch || !Array.isArray(cfg.accounts)) {
    // Still need the plain username array mbf-linux expects.
    const out = { ...cfg };
    if (!out.username) out.username = [];
    delete out.accounts;
    delete out.selectiveAccountSwitch;
    return out;
  }

  const allAccounts = cfg.accounts;
  const enabled = allAccounts.filter(a => a.enabled !== false);

  if (enabled.length === 0) {
    log("ERROR: No accounts are enabled. Enable at least one account in config.json.");
    process.exit(1);
  }

  const disabled = allAccounts.filter(a => a.enabled === false).map(a => a.username);
  if (disabled.length) log(`Skipping disabled account(s): ${disabled.join(", ")}`);
  log(`Active account(s): ${enabled.map(a => a.username).join(", ")}`);

  const enabledUsernames = enabled.map(a => a.username);
  const enabledIndices   = allAccounts.reduce((acc, a, i) => {
    if (a.enabled !== false) acc.push(i);
    return acc;
  }, []);

  // Re-index proxy arrays to match only the enabled accounts.
  let proxy = cfg.proxy ? { ...cfg.proxy } : undefined;
  if (proxy) {
    const arrayFields = ["ip", "port", "username", "password"];
    for (const field of arrayFields) {
      if (Array.isArray(proxy[field])) {
        proxy[field] = enabledIndices.map(i => proxy[field][i]).filter(v => v !== undefined);
        // Collapse single-element arrays back to a scalar (matches mbf-linux expectations).
        if (proxy[field].length === 1) proxy[field] = proxy[field][0];
      }
    }
  }

  const out = { ...cfg };
  delete out.accounts;
  delete out.selectiveAccountSwitch;
  out.username = enabledUsernames;
  if (proxy) out.proxy = proxy;
  return out;
}

// ---- Main ----

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
} catch (e) {
  log(`Failed to read config.json: ${e.message}`);
  process.exit(1);
}

const runtime = buildRuntimeConfig(cfg);

if (DRY) {
  log("Dry run — runtime config that would be passed to mbf-linux:");
  console.log(JSON.stringify(runtime, null, 2));
  process.exit(0);
}

// Write the runtime config the bot will actually read.
fs.writeFileSync(RUNTIME_PATH, JSON.stringify(runtime, null, 2));

// Temporarily replace config.json so mbf-linux picks it up.
const backup = CONFIG_PATH + ".bak";
fs.copyFileSync(CONFIG_PATH, backup);
fs.copyFileSync(RUNTIME_PATH, CONFIG_PATH);

log(`Launching mbf-linux...`);

let exitCode = 0;
try {
  const result = spawnSync(MBF_BIN, [], { stdio: "inherit" });
  exitCode = result.status ?? 0;
} finally {
  // Always restore the real config, even if the bot crashes.
  try {
    fs.copyFileSync(backup, CONFIG_PATH);
    fs.unlinkSync(backup);
  } catch {
    log("Warning: could not restore config.json — manually copy config.json.bak back.");
  }
  try { fs.unlinkSync(RUNTIME_PATH); } catch { /* already gone */ }
}

process.exit(exitCode);
