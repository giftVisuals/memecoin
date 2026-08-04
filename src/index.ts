import { config } from "./config.js";
import { logger } from "./notify/logger.js";
import { TradingEngine } from "./trading/engine.js";

logger.info(`Memecoin bot booting - mode: ${config.tradingMode}`);
if (config.tradingMode === "paper") {
  logger.info("Paper trading mode: no real funds are used. Tune the strategy here before going live.");
}

const engine = new TradingEngine();
await engine.start();

process.on("SIGINT", () => {
  logger.info("Shutting down...");
  engine.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  logger.info("Shutting down...");
  engine.stop();
  process.exit(0);
});
