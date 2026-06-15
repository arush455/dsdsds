/*
 * lib-mbf.js — shared helper for building the runtime config that mbf-linux reads.
 * Used by both start.js (manual launcher) and webhook-proxy.js (limit-guard orchestrator).
 */

/**
 * Build the cleaned runtime config mbf-linux expects (plain `username` array, no
 * `accounts`/`selectiveAccountSwitch` keys), with proxy arrays re-indexed to match
 * the selected accounts.
 *
 * @param {object} cfg   parsed config.json (the editable master)
 * @param {object} opts
 *   @param {string} [opts.onlyAccount]  force a single account by username (guard rotation)
 *   @param {boolean} [opts.routeWebhook=true]  rewrite webhook to the local guard
 *   @param {number} [opts.guardPort=8765]      port the guard listens on
 * @returns {{ runtime: object, selected: string[] }}
 */
function buildRuntimeConfig(cfg, opts = {}) {
  const { onlyAccount, routeWebhook = true, guardPort = 8765 } = opts;

  const hasAccounts = Array.isArray(cfg.accounts);
  const featureOn   = cfg.selectiveAccountSwitch && hasAccounts;

  // Decide which account objects are selected, and their indices into cfg.accounts
  // (needed to re-index the proxy arrays).
  let selectedObjs, selectedIndices;

  if (onlyAccount) {
    if (hasAccounts) {
      selectedIndices = cfg.accounts
        .map((a, i) => ({ a, i }))
        .filter(({ a }) => a.username === onlyAccount)
        .map(({ i }) => i);
      selectedObjs = selectedIndices.map(i => cfg.accounts[i]);
    }
    if (!selectedObjs || selectedObjs.length === 0) {
      // Account not in the array — synthesize it, no proxy index known.
      selectedObjs = [{ username: onlyAccount }];
      selectedIndices = [];
    }
  } else if (featureOn) {
    selectedIndices = cfg.accounts.reduce((acc, a, i) => {
      if (a.enabled !== false) acc.push(i);
      return acc;
    }, []);
    selectedObjs = selectedIndices.map(i => cfg.accounts[i]);
  } else if (hasAccounts) {
    // Feature off but accounts present — use them all in order.
    selectedIndices = cfg.accounts.map((_, i) => i);
    selectedObjs = cfg.accounts.slice();
  } else {
    // No accounts array at all — fall back to the plain username field.
    selectedObjs = null;
    selectedIndices = null;
  }

  const out = { ...cfg };
  delete out.accounts;
  delete out.selectiveAccountSwitch;

  let selected;
  if (selectedObjs) {
    selected = selectedObjs.map(a => a.username);
    out.username = selected;

    // Re-index proxy arrays so proxy[k] maps to the k-th selected account.
    if (out.proxy && Array.isArray(selectedIndices) && selectedIndices.length) {
      const proxy = { ...out.proxy };
      for (const field of ["ip", "port", "username", "password"]) {
        if (Array.isArray(proxy[field])) {
          let mapped = selectedIndices.map(i => proxy[field][i]).filter(v => v !== undefined);
          if (mapped.length === 1) mapped = mapped[0]; // collapse single -> scalar
          proxy[field] = mapped;
        }
      }
      out.proxy = proxy;
    }
  } else {
    selected = Array.isArray(out.username) ? out.username : (out.username ? [out.username] : []);
    if (!out.username) out.username = [];
  }

  if (routeWebhook && out.webhook) {
    out.webhook = `http://127.0.0.1:${guardPort}`;
  }

  return { runtime: out, selected };
}

module.exports = { buildRuntimeConfig };
