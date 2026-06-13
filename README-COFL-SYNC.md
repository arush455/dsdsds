# CoflNet auto-filter sync

Keeps your `filter.json` fresh by pulling profitable bazaar flips from the CoflNet
(sky.coflnet.com) API and listing them automatically. You have CoflNet Premium, so it
uses the **demand-aware** premium endpoint and falls back to the free one if needed.

## Why a separate script?
The MBF bot has no built-in "CoflNet API" config field — it only reads `filter.json`.
So this script does the integration: it talks to CoflNet, then writes the items straight
into `filter.json`. Your blacklist and any items **you** added by hand are never touched —
the script only manages the items it adds itself (tracked in `.cofl-auto.json`).

## 1. Get your CoflNet token
In-game with the SkyCofl mod installed, run:

```
/cofl api
```

Copy the token it gives you. (This is tied to your Premium account, which unlocks the
demand-aware flips.)

## 2. Paste it into the config
Open `cofl-sync.config.json` and replace `PASTE_YOUR_COFL_TOKEN_HERE`:

```json
{
  "coflToken": "your-token-here",
  "usePremiumDemand": true,
  "runEveryMinutes": 30,
  "maxAutoItems": 40,
  "thresholds": {
    "minProfit": 5000,
    "minPercentage": 3,
    "minVolume": 1000,
    "maxPrice": 120000000,
    "skipManipulated": true
  }
}
```

These thresholds mirror your `config.json`, so auto-listed items respect the same standards.
Lower `maxAutoItems` or raise the thresholds if you start hitting your 15B daily limit.

## 3. Run it
Requires Node.js (same as the bot). From this folder:

```bash
node cofl-sync.js            # runs forever, refreshes every 30 min
node cofl-sync.js --once     # one update then exits (use with cron)
node cofl-sync.js --debug    # prints one raw API item so field names can be verified
```

Run it **alongside** the bot. To keep it alive on your VPS, use pm2:

```bash
pm2 start cofl-sync.js --name cofl-sync
pm2 save
```

Or a cron job (every 30 min):

```
*/30 * * * * cd /path/to/bot && /usr/bin/node cofl-sync.js --once >> cofl-sync.log 2>&1
```

## Notes
- If the bot doesn't hot-reload `filter.json`, restart it after a sync (or check its docs
  for a reload command). The sync writes atomically, so the bot never reads a half-written file.
- It posts a short summary to your Discord webhook on each run (reuses the webhook from
  `config.json` unless you set one in `cofl-sync.config.json`).
- First time you run with a real token, do `node cofl-sync.js --debug` and send me the
  printed sample if any field looks off — the parser already handles the common field names,
  but that confirms it against live data.
