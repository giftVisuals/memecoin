import "dotenv/config";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got "${raw}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true";
}

function str(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const tradingMode = str("TRADING_MODE", "paper") as "paper" | "live";
const understandRisk = bool("I_UNDERSTAND_THE_RISK", false);

if (tradingMode === "live" && !understandRisk) {
  throw new Error(
    "TRADING_MODE=live requires I_UNDERSTAND_THE_RISK=true. This trades real funds. " +
      "Run in paper mode first and only flip this once you've reviewed the strategy."
  );
}

export const config = {
  tradingMode,

  wallet: {
    privateKey: str("SOLANA_PRIVATE_KEY", ""),
    rpcUrl: str("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
  },

  bankroll: {
    startingPaperBalanceSol: num("STARTING_PAPER_BALANCE_SOL", 0.05),
    positionSizeSol: num("POSITION_SIZE_SOL", 0.01),
    maxConcurrentPositions: num("MAX_CONCURRENT_POSITIONS", 3),
    watchlistPositionMultiplier: num("WATCHLIST_POSITION_MULTIPLIER", 2),
  },

  filters: {
    minLiquiditySol: num("MIN_LIQUIDITY_SOL", 3),
    maxTopHolderPct: num("MAX_TOP_HOLDER_PCT", 25),
    requireMintAuthorityRenounced: bool("REQUIRE_MINT_AUTHORITY_RENOUNCED", true),
    requireFreezeAuthorityRenounced: bool("REQUIRE_FREEZE_AUTHORITY_RENOUNCED", true),
    minTokenAgeSec: num("MIN_TOKEN_AGE_SEC", 20),
    maxTokenAgeSec: num("MAX_TOKEN_AGE_SEC", 180),
    maxSellPriceImpactPct: num("MAX_SELL_PRICE_IMPACT_PCT", 15),
  },

  exits: {
    takeProfitPct: num("TAKE_PROFIT_PCT", 50),
    stopLossPct: num("STOP_LOSS_PCT", 20),
    trailingStopPct: num("TRAILING_STOP_PCT", 15),
    maxHoldTimeSec: num("MAX_HOLD_TIME_SEC", 900),
  },

  watchlist: {
    keywords: str("WATCHLIST_KEYWORDS", "trump,elon,musk,melania")
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean),
  },

  sources: {
    pumpfunWsUrl: str("PUMPFUN_WS_URL", "wss://pumpportal.fun/api/data"),
    dexscreenerApiUrl: str("DEXSCREENER_API_URL", "https://api.dexscreener.com"),
  },

  dataDir: str("DATA_DIR", "./data"),
};

export type Config = typeof config;
