import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { backupSettings } from "./persistence/cloudBackup.js";
import { logger } from "./notify/logger.js";

const filePath = path.join(config.dataDir, "settings.json");

// Everything here is tunable from the dashboard without a redeploy. Initial
// values come from .env on first boot; after that, data/settings.json is the
// source of truth and env vars for these specific keys are ignored.
const DEFAULT_SETTINGS = {
  // Kill switch: when true, the engine stops opening new positions. Existing
  // open positions keep running their normal take-profit/stop-loss/trailing
  // rules - pausing never abandons a position mid-trade.
  tradingPaused: false,

  // Display name for the primary wallet (from SOLANA_PRIVATE_KEY) in the
  // dashboard's Wallets tab.
  primaryWalletName: "Main",

  watchlistKeywords: ["trump", "elon", "musk", "melania"],

  positionSizeSol: 0.01,
  maxConcurrentPositions: 3,
  watchlistPositionMultiplier: 2,

  minLiquiditySol: 3,
  maxTopHolderPct: 25,
  requireMintAuthorityRenounced: true,
  requireFreezeAuthorityRenounced: true,
  minTokenAgeSec: 20,
  maxTokenAgeSec: 180,
  maxSellPriceImpactPct: 15,

  // TRADING_MODE=signal only: how good a candidate has to look before it's
  // worth pinging Telegram about. Kept separate from the trading filters
  // above since "worth alerting a human" is a lower bar than "worth an
  // automatic buy."
  minMatchConfidencePct: 50,
  minHolderCount: 10,
  maxTop10HolderPct: 50,

  // Flat take-profit close. Only used when profitRatchetEnabled is false -
  // when the ratchet is on, it takes over deciding when to lock in gains
  // instead of just selling everything the moment price doubles.
  takeProfitPct: 50,
  stopLossPct: 20,
  trailingStopPct: 15,
  maxHoldTimeSec: 900,

  // "Let winners run instead of selling at the first 2X": once price hits a
  // rung's trigger multiple, the stop floor locks up to that rung's floor
  // multiple instead of closing the position outright. Format is
  // "trigger:floor" pairs, e.g. "2:1" = once price hits 2X entry, floor
  // becomes 1X (breakeven) - the position keeps running with the downside
  // capped at "no loss" instead of exiting. Past the last rung, trailingStopPct
  // takes over as a plain percentage giveback from the high so there's no
  // need to hand-tune rungs for infinity.
  profitRatchetEnabled: true,
  profitRatchetLadder: "2:1,3:2,5:3,10:8,20:15",

  // Signal mode only: wallets to watch for "smart money" buy alerts.
  // Format: "label:address" pairs, comma or newline separated. You add
  // these yourself (e.g. copied from a "top traders" leaderboard you
  // trust) - the bot doesn't discover them on its own. Free to watch (uses
  // the same Helius RPC connection as everything else) - just add an
  // address here and watching starts on the next refresh.
  smartWallets: "",
};

// Parses "Whale1:Addr1, Whale2:Addr2\nWhale3:Addr3" into
// [{label, address}, ...]. Entries that don't look like a plausible Solana
// address (base58, 32-44 chars) are silently skipped rather than throwing -
// a typo shouldn't be able to break the whole watchlist, and an all-skipped
// result (or an empty string) is a valid "tracking nothing yet" state.
const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parseSmartWallets(str) {
  return String(str || "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.lastIndexOf(":");
      const label = idx === -1 ? "Wallet" : entry.slice(0, idx).trim();
      const address = (idx === -1 ? entry : entry.slice(idx + 1)).trim();
      return { label: label || "Wallet", address };
    })
    .filter((w) => BASE58_ADDRESS_RE.test(w.address));
}

// Parses "2:1,3:2,5:3" into [{at:2,floor:1}, {at:3,floor:2}, {at:5,floor:3}],
// sorted ascending by trigger multiple. Used by position.js on every new
// position (ladder is read once at open, matching how TP/SL/trailing are
// already snapshotted at open time). Invalid/malformed entries are skipped
// rather than throwing, so a typo in the dashboard field can't crash trading.
export function parseRatchetLadder(str) {
  return String(str || "")
    .split(",")
    .map((pair) => {
      const [at, floor] = pair.split(":").map((n) => Number(n.trim()));
      return { at, floor };
    })
    .filter((r) => Number.isFinite(r.at) && Number.isFinite(r.floor) && r.at > 1 && r.floor <= r.at)
    .sort((a, b) => a.at - b.at);
}

function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function readFromEnvDefaults() {
  const str = (name, fallback) => process.env[name] ?? fallback;
  const num = (name, fallback) => {
    const raw = process.env[name];
    return raw === undefined || raw === "" ? fallback : Number(raw);
  };
  const bool = (name, fallback) => {
    const raw = process.env[name];
    return raw === undefined || raw === "" ? fallback : raw.toLowerCase() === "true";
  };

  return {
    tradingPaused: false,
    primaryWalletName: DEFAULT_SETTINGS.primaryWalletName,
    watchlistKeywords: str("WATCHLIST_KEYWORDS", DEFAULT_SETTINGS.watchlistKeywords.join(","))
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean),
    positionSizeSol: num("POSITION_SIZE_SOL", DEFAULT_SETTINGS.positionSizeSol),
    maxConcurrentPositions: num("MAX_CONCURRENT_POSITIONS", DEFAULT_SETTINGS.maxConcurrentPositions),
    watchlistPositionMultiplier: num(
      "WATCHLIST_POSITION_MULTIPLIER",
      DEFAULT_SETTINGS.watchlistPositionMultiplier
    ),
    minLiquiditySol: num("MIN_LIQUIDITY_SOL", DEFAULT_SETTINGS.minLiquiditySol),
    maxTopHolderPct: num("MAX_TOP_HOLDER_PCT", DEFAULT_SETTINGS.maxTopHolderPct),
    requireMintAuthorityRenounced: bool(
      "REQUIRE_MINT_AUTHORITY_RENOUNCED",
      DEFAULT_SETTINGS.requireMintAuthorityRenounced
    ),
    requireFreezeAuthorityRenounced: bool(
      "REQUIRE_FREEZE_AUTHORITY_RENOUNCED",
      DEFAULT_SETTINGS.requireFreezeAuthorityRenounced
    ),
    minTokenAgeSec: num("MIN_TOKEN_AGE_SEC", DEFAULT_SETTINGS.minTokenAgeSec),
    maxTokenAgeSec: num("MAX_TOKEN_AGE_SEC", DEFAULT_SETTINGS.maxTokenAgeSec),
    maxSellPriceImpactPct: num("MAX_SELL_PRICE_IMPACT_PCT", DEFAULT_SETTINGS.maxSellPriceImpactPct),
    minMatchConfidencePct: num("MIN_MATCH_CONFIDENCE_PCT", DEFAULT_SETTINGS.minMatchConfidencePct),
    minHolderCount: num("MIN_HOLDER_COUNT", DEFAULT_SETTINGS.minHolderCount),
    maxTop10HolderPct: num("MAX_TOP10_HOLDER_PCT", DEFAULT_SETTINGS.maxTop10HolderPct),
    takeProfitPct: num("TAKE_PROFIT_PCT", DEFAULT_SETTINGS.takeProfitPct),
    stopLossPct: num("STOP_LOSS_PCT", DEFAULT_SETTINGS.stopLossPct),
    trailingStopPct: num("TRAILING_STOP_PCT", DEFAULT_SETTINGS.trailingStopPct),
    maxHoldTimeSec: num("MAX_HOLD_TIME_SEC", DEFAULT_SETTINGS.maxHoldTimeSec),
    profitRatchetEnabled: bool("PROFIT_RATCHET_ENABLED", DEFAULT_SETTINGS.profitRatchetEnabled),
    profitRatchetLadder: str("PROFIT_RATCHET_LADDER", DEFAULT_SETTINGS.profitRatchetLadder),
    smartWallets: str("SMART_WALLETS", DEFAULT_SETTINGS.smartWallets),
  };
}

let cache = null;

function load() {
  if (cache) return cache;
  ensureDataDir();
  if (!fs.existsSync(filePath)) {
    cache = readFromEnvDefaults();
    const content = JSON.stringify(cache, null, 2);
    fs.writeFileSync(filePath, content);
    // Fire-and-forget is acceptable only here: load() must stay synchronous
    // (called everywhere via getSettings()), and this first-ever-boot seed
    // is just the .env defaults, not a deliberate user change - low stakes
    // if a redeploy races it. updateSettings() below awaits properly since
    // that's a real user action that shouldn't be able to silently vanish.
    backupSettings(content); // fire-and-forget - never rejects, just logs on failure
    return cache;
  }
  cache = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(filePath, "utf-8")) };
  return cache;
}

const NUMERIC_KEYS = [
  "positionSizeSol",
  "maxConcurrentPositions",
  "watchlistPositionMultiplier",
  "minLiquiditySol",
  "maxTopHolderPct",
  "minTokenAgeSec",
  "maxTokenAgeSec",
  "maxSellPriceImpactPct",
  "minMatchConfidencePct",
  "minHolderCount",
  "maxTop10HolderPct",
  "takeProfitPct",
  "stopLossPct",
  "trailingStopPct",
  "maxHoldTimeSec",
];
const BOOLEAN_KEYS = [
  "requireMintAuthorityRenounced",
  "requireFreezeAuthorityRenounced",
  "tradingPaused",
  "profitRatchetEnabled",
];

export function getSettings() {
  return load();
}

// Validates and merges a partial update, persists it, and returns the new
// settings. Throws on bad input so the API layer can turn that into a 400.
// Awaits the cloud backup - a deliberate settings change from the dashboard
// shouldn't be able to silently vanish on the next redeploy.
export async function updateSettings(partial) {
  const current = load();
  const next = { ...current };

  if (partial.primaryWalletName !== undefined) {
    const trimmed = String(partial.primaryWalletName).trim();
    if (trimmed) next.primaryWalletName = trimmed;
  }

  if (partial.watchlistKeywords !== undefined) {
    if (!Array.isArray(partial.watchlistKeywords)) {
      throw new Error("watchlistKeywords must be an array of strings");
    }
    next.watchlistKeywords = partial.watchlistKeywords
      .map((k) => String(k).trim().toLowerCase())
      .filter(Boolean);
  }

  if (partial.profitRatchetLadder !== undefined) {
    const str = String(partial.profitRatchetLadder).trim();
    if (!str || parseRatchetLadder(str).length === 0) {
      throw new Error('profitRatchetLadder must look like "2:1,3:2,5:3,10:8" (trigger multiple : floor multiple)');
    }
    next.profitRatchetLadder = str;
  }

  if (partial.smartWallets !== undefined) {
    // Empty is fine (tracking nothing yet) - no validation error, unlike the
    // ratchet ladder above. Malformed individual entries are just quietly
    // dropped by parseSmartWallets when the list is actually read.
    next.smartWallets = String(partial.smartWallets).trim();
  }

  for (const key of NUMERIC_KEYS) {
    if (partial[key] === undefined) continue;
    const n = Number(partial[key]);
    if (Number.isNaN(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
    next[key] = n;
  }

  for (const key of BOOLEAN_KEYS) {
    if (partial[key] === undefined) continue;
    next[key] = Boolean(partial[key]);
  }

  ensureDataDir();
  const content = JSON.stringify(next, null, 2);
  fs.writeFileSync(filePath, content);
  cache = next;
  const backedUp = await backupSettings(content);
  if (!backedUp) {
    logger.error("Settings change saved locally but NOT backed up to the cloud.");
  }
  return next;
}
