import { config } from "./config.js";
import { logger } from "./notify/logger.js";
import { TradingEngine } from "./trading/engine.js";
import { startDashboardServer } from "./web/server.js";
import { restoreFromCloud, enabled as cloudBackupEnabled } from "./persistence/cloudBackup.js";

logger.info(`Memecoin bot booting - mode: ${config.tradingMode}`);
if (config.tradingMode === "paper") {
  logger.info("Paper trading mode: no real funds are used. Tune the strategy here before going live.");
}
logger.info(
  cloudBackupEnabled
    ? "Cloud backup enabled - trade history and settings survive redeploys."
    : "Cloud backup not configured - trade history and settings reset on every redeploy " +
        "(set UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN to fix this)."
);
await restoreFromCloud();

const engine = new TradingEngine();
await engine.start();

const dashboard = startDashboardServer(engine);

process.on("SIGINT", () => {
  logger.info("Shutting down...");
  engine.stop();
  dashboard.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  logger.info("Shutting down...");
  engine.stop();
  dashboard.close();
  process.exit(0);
});
