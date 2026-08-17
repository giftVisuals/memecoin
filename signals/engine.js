import { getSettings } from "../settings.js";
import { logger } from "../notify/logger.js";
import { PumpFunSource } from "../sources/pumpfun.js";
import { fetchPairData } from "../sources/dexscreener.js";
import { getSolUsdPrice } from "../sources/solPrice.js";
import { getMintInfo } from "../solanaConnection.js";
import { getTopHolderStats, getHolderCount } from "./holders.js";
import { checkSellable } from "../safety/honeypot.js";
import { scoreCandidate } from "./scorer.js";
import { formatNewTokenAlert } from "./format.js";
import { sendTelegramMessage, telegramEnabled } from "../notify/telegram.js";
import { alertStore } from "../persistence/alertStore.js";

const TICK_INTERVAL_MS = 5000;
// Below this, a candidate isn't worth spending the expensive per-token RPC
// calls (holder count) or the Jupiter honeypot check on - it'll just get
// rechecked next tick in case the picture improves (holder % dilutes fast
// as more people buy in early on).
const PRELIMINARY_CONFIDENCE_FLOOR_PCT = 30;

export class SignalEngine {
  source = new PumpFunSource();
  pending = new Map();
  tickHandle = null;

  async start() {
    logger.info("Starting in SIGNAL mode - watching for new tokens, no funds at risk.");

    this.source.on("newToken", (event) => this.onNewToken(event));
    this.source.on("connected", () => logger.info("Connected to pump.fun new-token feed"));
    this.source.on("disconnected", () => logger.warn("Disconnected from pump.fun feed, reconnecting..."));
    this.source.on("error", (err) => logger.error(`pump.fun feed error: ${err.message}`));
    this.source.start();

    this.tickHandle = setInterval(() => {
      this.processCandidates().catch((err) => logger.error(`processCandidates failed: ${err}`));
    }, TICK_INTERVAL_MS);
  }

  stop() {
    this.source.stop();
    if (this.tickHandle) clearInterval(this.tickHandle);
  }

  onNewToken(event) {
    if (this.pending.has(event.mint) || alertStore.wasAlerted(event.mint)) return;
    this.pending.set(event.mint, { event });
    logger.info(`New token: ${event.symbol} (${event.name}) ${event.mint}`);
  }

  async processCandidates() {
    const now = Date.now();
    const settings = getSettings();

    for (const [mint, candidate] of this.pending) {
      const ageSec = (now - candidate.event.seenAt) / 1000;

      if (ageSec < settings.minTokenAgeSec) continue;

      if (ageSec > settings.maxTokenAgeSec) {
        this.pending.delete(mint);
        const lastReason = candidate.lastReason ? ` (last reason: ${candidate.lastReason})` : "";
        logger.info(`Dropped ${candidate.event.symbol}: aged out of the alert window${lastReason}`);
        continue;
      }

      try {
        await this.evaluateCandidate(candidate);
      } catch (err) {
        logger.error(`Evaluating ${candidate.event.symbol} failed: ${err.message}`);
      }
    }
  }

  async evaluateCandidate(candidate) {
    const { event } = candidate;
    const settings = getSettings();

    const mintInfo = await getMintInfo(event.mint);
    if (!mintInfo) {
      this.logRejectionIfChanged(candidate, "could not read mint account (RPC issue or invalid mint)");
      return;
    }

    const { top1Pct, top10Pct } = await getTopHolderStats(event.mint, mintInfo.supply);
    const pair = await fetchPairData(event.mint);
    // Pre-migration tokens often aren't indexed by DexScreener yet - fall
    // back to the bonding-curve numbers pump.fun itself reported at
    // creation, which is stale but real, rather than showing "$0".
    const liquiditySol = pair?.liquiditySol > 0 ? pair.liquiditySol : event.initialLiquiditySol;

    const preliminary = scoreCandidate({ mintInfo, top1Pct, top10Pct, liquiditySol });
    if (preliminary.matchConfidencePct < PRELIMINARY_CONFIDENCE_FLOOR_PCT) {
      this.logRejectionIfChanged(
        candidate,
        `preliminary score too low (${preliminary.matchConfidencePct}% - ` +
          `top1 ${top1Pct.toFixed(1)}%, top10 ${top10Pct.toFixed(1)}%)`
      );
      return;
    }

    // Looks promising enough to justify the expensive checks.
    const [holderCount, honeypotCheck] = await Promise.all([
      getHolderCount(event.mint),
      checkSellable(event.mint, mintInfo.decimals),
    ]);

    const score = scoreCandidate({
      mintInfo,
      top1Pct,
      top10Pct,
      holderCount,
      liquiditySol,
      sellable: honeypotCheck.sellable,
    });

    if (score.matchConfidencePct < settings.minMatchConfidencePct) {
      this.logRejectionIfChanged(
        candidate,
        `confidence ${score.matchConfidencePct}% below ${settings.minMatchConfidencePct}% threshold` +
          (honeypotCheck.sellable ? "" : ` (${honeypotCheck.reason})`)
      );
      return;
    }

    this.pending.delete(event.mint);
    await this.sendAlert(event, { liquiditySol, holderCount, top10Pct, score });
  }

  async sendAlert(event, { liquiditySol, holderCount, top10Pct, score }) {
    const solUsd = await getSolUsdPrice();
    const liquidityUsd = liquiditySol * solUsd;
    const marketCapUsd = event.marketCapSol * solUsd;

    const html = formatNewTokenAlert({
      event,
      mint: event.mint,
      liquidityUsd,
      marketCapUsd,
      holderCount,
      top10Pct,
      score,
    });

    const sent = await sendTelegramMessage(html);
    alertStore.markAlerted(event.mint); // mark alerted regardless - don't spam-retry a send failure forever
    if (sent) {
      logger.info(`Alerted on ${event.symbol}: confidence ${score.matchConfidencePct}%, risk ${score.riskScore}/10`);
    }
  }

  logRejectionIfChanged(candidate, reason) {
    if (candidate.lastReason === reason) return;
    candidate.lastReason = reason;
    logger.info(`Not yet alerting on ${candidate.event.symbol} (rechecking): ${reason}`);
  }

  // Minimal status for the dashboard's /api/status in signal mode.
  getStatus() {
    return {
      mode: "signal",
      pendingCandidates: this.pending.size,
      telegramConfigured: telegramEnabled,
    };
  }
}
