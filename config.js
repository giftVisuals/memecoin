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

// "signal" mode never places a trade - it just watches and sends Telegram
// alerts. No wallet, no funds at risk, nothing to lose on a bad call.
if (tradingMode !== "paper" && tradingMode !== "live" && tradingMode !== "signal") {
  throw new Error(`TRADING_MODE must be "paper", "live", or "signal", got "${tradingMode}"`);
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

  // Only needed for TRADING_MODE=signal. Get the token from @BotFather (or
  // reuse an existing bot like @vewogrobot's token). Chat ID is the
  // destination for alerts - see README for how to find it.
  telegram: {
    botToken: str("TELEGRAM_BOT_TOKEN", ""),
    chatId: str("TELEGRAM_CHAT_ID", ""),
  },

  port: num("PORT", 3000),
  dashboardPassword: str("DASHBOARD_PASSWORD", ""),

  // Required to add wallets from the dashboard (each one's private key is
  // encrypted at rest with this before being stored). Any long random
  // string works - set once in Railway, never committed.
  walletEncryptionKey: str("WALLET_ENCRYPTION_KEY", ""),

  // Optional: free Upstash Redis REST API, used to back up trade history and
  // settings so they survive a redeploy without needing a Railway Volume.
  // Both unset = feature is simply off, everything else behaves as before.
  cloudBackup: {
    url: str("UPSTASH_REDIS_REST_URL", ""),
    token: str("UPSTASH_REDIS_REST_TOKEN", ""),
  },
};
