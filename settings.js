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

  takeProfitPct: 50,
  stopLossPct: 20,
  trailingStopPct: 15,
  maxHoldTimeSec: 900,
};

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
    takeProfitPct: num("TAKE_PROFIT_PCT", DEFAULT_SETTINGS.takeProfitPct),
    stopLossPct: num("STOP_LOSS_PCT", DEFAULT_SETTINGS.stopLossPct),
    trailingStopPct: num("TRAILING_STOP_PCT", DEFAULT_SETTINGS.trailingStopPct),
    maxHoldTimeSec: num("MAX_HOLD_TIME_SEC", DEFAULT_SETTINGS.maxHoldTimeSec),
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
  "takeProfitPct",
  "stopLossPct",
  "trailingStopPct",
  "maxHoldTimeSec",
];
const BOOLEAN_KEYS = ["requireMintAuthorityRenounced", "requireFreezeAuthorityRenounced", "tradingPaused"];

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
