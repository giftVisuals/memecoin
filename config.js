import "dotenv/config";

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got "${raw}"`);
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true";
}

function str(name, fallback) {
  return process.env[name] ?? fallback;
}

const tradingMode = str("TRADING_MODE", "paper").trim().toLowerCase();
const understandRisk = bool("I_UNDERSTAND_THE_RISK", false);

if (tradingMode !== "paper" && tradingMode !== "live") {
  throw new Error(`TRADING_MODE must be "paper" or "live", got "${tradingMode}"`);
}

if (tradingMode === "live" && !understandRisk) {
  throw new Error(
    "TRADING_MODE=live requires I_UNDERSTAND_THE_RISK=true. This trades real funds. " +
      "Run in paper mode first and only flip this once you've reviewed the strategy."
  );
}

// Note: the tunable trading parameters (watchlist, position size, TP/SL,
// filters) used to live here. They now live in settings.js, backed by
// data/settings.json, so they're editable from the dashboard without a
// redeploy. This file is only for things that genuinely need a restart to
// change: trading mode, wallet, network, and process config.
export const config = {
  tradingMode,

  wallet: {
    privateKey: str("SOLANA_PRIVATE_KEY", ""),
    rpcUrl: str("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
  },

  bankroll: {
    startingPaperBalanceSol: num("STARTING_PAPER_BALANCE_SOL", 0.05),
  },

  sources: {
    pumpfunWsUrl: str("PUMPFUN_WS_URL", "wss://pumpportal.fun/api/data"),
    dexscreenerApiUrl: str("DEXSCREENER_API_URL", "https://api.dexscreener.com"),
  },

  dataDir: str("DATA_DIR", "./data"),

  port: num("PORT", 3000),
  dashboardPassword: str("DASHBOARD_PASSWORD", ""),

  // Optional: free Upstash Redis REST API, used to back up trade history and
  // settings so they survive a redeploy without needing a Railway Volume.
  // Both unset = feature is simply off, everything else behaves as before.
  cloudBackup: {
    url: str("UPSTASH_REDIS_REST_URL", ""),
    token: str("UPSTASH_REDIS_REST_TOKEN", ""),
  },
};
