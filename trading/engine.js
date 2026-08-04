import { config } from "../config.js";
import { logger } from "../notify/logger.js";
import { PumpFunSource } from "../sources/pumpfun.js";
import { fetchPairData } from "../sources/dexscreener.js";
import { isWatchlisted } from "../sources/watchlist.js";
import { runSafetyFilters } from "../safety/filters.js";
import { checkSellable } from "../safety/honeypot.js";
import { getMintInfo } from "../solanaConnection.js";
import { Position } from "./position.js";
import { PaperBroker } from "./paperBroker.js";
import { LiveBroker } from "./liveBroker.js";

const TICK_INTERVAL_MS = 5000;

export class TradingEngine {
  source = new PumpFunSource();
  broker = config.tradingMode === "live" ? new LiveBroker() : new PaperBroker();
  pending = new Map();
  openPositions = new Map();
  tickHandle = null;

  async start() {
    logger.info(
      `Starting in ${config.tradingMode.toUpperCase()} mode. ` +
        `Balance: ${(await this.broker.getBalanceSol()).toFixed(4)} SOL`
    );

    this.source.on("newToken", (event) => this.onNewToken(event));
    this.source.on("connected", () => logger.info("Connected to pump.fun new-token feed"));
    this.source.on("disconnected", () => logger.warn("Disconnected from pump.fun feed, reconnecting..."));
    this.source.on("error", (err) => logger.error(`pump.fun feed error: ${err.message}`));
    this.source.start();

    this.tickHandle = setInterval(() => {
      this.processCandidates().catch((err) => logger.error(`processCandidates failed: ${err}`));
      this.monitorPositions().catch((err) => logger.error(`monitorPositions failed: ${err}`));
    }, TICK_INTERVAL_MS);
  }

  stop() {
    this.source.stop();
    if (this.tickHandle) clearInterval(this.tickHandle);
  }

  onNewToken(event) {
    if (this.pending.has(event.mint) || this.openPositions.has(event.mint)) return;
    this.pending.set(event.mint, { event });

    const watchlistTag = isWatchlisted(event.name, event.symbol) ? " [WATCHLIST]" : "";
    logger.info(`New token: ${event.symbol} (${event.name}) ${event.mint}${watchlistTag}`);
  }

  async processCandidates() {
    const now = Date.now();

    for (const [mint, candidate] of this.pending) {
      const ageSec = (now - candidate.event.seenAt) / 1000;

      if (ageSec < config.filters.minTokenAgeSec) continue; // still waiting for the minimum age

      if (ageSec > config.filters.maxTokenAgeSec) {
        this.pending.delete(mint);
        logger.info(`Dropped ${candidate.event.symbol}: aged out of the buy window`);
        continue;
      }

      await this.evaluateCandidate(candidate, ageSec);
    }
  }

  async evaluateCandidate(candidate, ageSec) {
    const { event } = candidate;

    const pair = await fetchPairData(event.mint);
    if (!pair) return; // not indexed by DexScreener yet, try again next tick

    const filterResult = await runSafetyFilters(event.mint, pair, ageSec);
    if (!filterResult.passed) {
      this.pending.delete(event.mint);
      logger.info(`Rejected ${event.symbol}: ${filterResult.reasons.join("; ")}`);
      return;
    }

    const mintInfo = await getMintInfo(event.mint);
    const decimals = mintInfo?.decimals ?? 6;
    const honeypotCheck = await checkSellable(event.mint, decimals);
    if (!honeypotCheck.sellable) {
      this.pending.delete(event.mint);
      logger.info(`Rejected ${event.symbol}: ${honeypotCheck.reason}`);
      return;
    }

    this.pending.delete(event.mint);
    await this.buy(event, pair.priceSol);
  }

  async buy(event, priceSol) {
    if (this.openPositions.size >= config.bankroll.maxConcurrentPositions) {
      logger.info(
        `Skipping ${event.symbol}: max concurrent positions (${config.bankroll.maxConcurrentPositions}) reached`
      );
      return;
    }

    const watchlisted = isWatchlisted(event.name, event.symbol);
    const targetSize =
      config.bankroll.positionSizeSol * (watchlisted ? config.bankroll.watchlistPositionMultiplier : 1);
    const balance = await this.broker.getBalanceSol();

    if (balance < targetSize * 0.5) {
      logger.warn(`Skipping ${event.symbol}: balance too low (${balance.toFixed(4)} SOL)`);
      return;
    }
    const solAmount = Math.min(targetSize, balance);

    try {
      const result = await this.broker.buy(event.mint, event.symbol, priceSol, solAmount);
      const position = new Position({
        mint: event.mint,
        symbol: event.symbol,
        isWatchlisted: watchlisted,
        entryPriceSol: priceSol,
        amountTokens: result.amountTokens,
        amountSolSpent: result.amountSolSpent,
        openedAt: Date.now(),
      });
      this.openPositions.set(event.mint, position);
      logger.trade(
        `BOUGHT ${event.symbol} - ${solAmount.toFixed(4)} SOL @ ${priceSol.toFixed(8)} SOL/token` +
          (watchlisted ? " (watchlisted - extended targets)" : "")
      );
    } catch (err) {
      logger.error(`Buy failed for ${event.symbol}: ${err}`);
    }
  }

  async monitorPositions() {
    const now = Date.now();

    for (const [mint, position] of this.openPositions) {
      const pair = await fetchPairData(mint);
      if (!pair) continue;

      const { shouldClose, reason } = position.evaluate(pair.priceSol, now);
      if (!shouldClose) continue;

      try {
        const result = await this.broker.sell(mint, position.symbol, pair.priceSol, position.amountTokens);
        const pnlPct = position.pnlPct(pair.priceSol);
        this.openPositions.delete(mint);
        logger.trade(
          `SOLD ${position.symbol} - reason: ${reason}, pnl: ${pnlPct.toFixed(1)}%, ` +
            `received ${result.amountSolReceived.toFixed(4)} SOL`
        );
      } catch (err) {
        logger.error(`Sell failed for ${position.symbol}: ${err}`);
      }
    }
  }
}
