import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const filePath = path.join(config.dataDir, "alertedMints.json");
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000; // no reason to remember further back than that

// Dedupe list for signal mode: which mints we've already sent a Telegram
// alert for, so a restart or a slow-to-ageout candidate doesn't ping twice.
// Deliberately not cloud-backed - unlike wallets or settings, losing this on
// a redeploy just means a possible one-time repeat alert, not lost funds or
// a lost account. Not worth the extra moving part.
let cache = null;

function load() {
  if (cache) return cache;
  if (!fs.existsSync(filePath)) {
    cache = [];
    return cache;
  }
  try {
    cache = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    cache = [];
  }
  return cache;
}

function save(entries) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
  cache = entries;
}

export const alertStore = {
  wasAlerted(mint) {
    return load().some((e) => e.mint === mint);
  },

  markAlerted(mint) {
    const now = Date.now();
    const pruned = load().filter((e) => now - e.alertedAt < PRUNE_AFTER_MS);
    pruned.push({ mint, alertedAt: now });
    save(pruned);
  },
};
