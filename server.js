import { config } from "./config.js";
import { logger } from "./notify/logger.js";
import { TradingEngine } from "./trading/engine.js";
import { SignalEngine } from "./signals/engine.js";
import { WhaleEngine } from "./signals/whaleEngine.js";
import { manualTrading } from "./signals/manualTrading.js";
import { telegramEnabled } from "./notify/telegram.js";
import { startDashboardServer } from "./web/server.js";
import { restoreFromCloud, enabled as cloudBackupEnabled } from "./persistence/cloudBackup.js";

logger.info(`Memecoin bot booting - mode: ${config.tradingMode}`);
if (config.tradingMode === "paper") {
  logger.info("Paper trading mode: no real funds are used. Tune the strategy here before going live.");
}
if (config.tradingMode === "signal") {
  logger.info(
    telegramEnabled
      ? "Signal mode: watching pump.fun and alerting to Telegram. Nothing trades on its own - " +
          "funds only move if you tap Buy Now on an alert."
      : "Signal mode: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set yet - candidates will be evaluated " +
          "but no alerts can be sent until both are configured in Railway."
  );
}
logger.info(
  cloudBackupEnabled
    ? "Cloud backup enabled - trade history and settings survive redeploys."
    : "Cloud backup not configured - trade history and settings reset on every redeploy " +
        "(set UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN to fix this)."
);
await restoreFromCloud();

const engine = config.tradingMode === "signal" ? new SignalEngine() : new TradingEngine();
await engine.start();

// Independent of the main engine - free (uses the same Helius RPC
// connection), only relevant in signal mode, inert until the dashboard's
// Smart Wallets list has at least one address in it.
const whaleEngine = config.tradingMode === "signal" ? new WhaleEngine() : null;
if (whaleEngine) await whaleEngine.start();

// Buy Now / Sell Now button handling - also signal mode only, also inert
// unless Telegram is configured.
if (config.tradingMode === "signal") await manualTrading.start();

const dashboard = startDashboardServer(engine);

process.on("SIGINT", () => {
  logger.info("Shutting down...");
  engine.stop();
  whaleEngine?.stop();
  manualTrading.stop();
  dashboard.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  logger.info("Shutting down...");
  engine.stop();
  whaleEngine?.stop();
  manualTrading.stop();
  dashboard.close();
  process.exit(0);
});
