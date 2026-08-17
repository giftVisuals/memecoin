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
import { buyButtonMarkup } from "./manualTrading.js";
import { alertStore } from "../persistence/alertStore.js";

// Signal mode isn't racing anyone to buy - alerting a few seconds later
// costs nothing, so this stays wide to keep RPC/API call volume (and
// Railway's usage-based cost) down. Was 5s; every pending candidate gets
// re-evaluated on every tick until it's dropped, so this number directly
// multiplies how often that happens.
const TICK_INTERVAL_MS = 15_000;
// Below this, a candidate isn't worth spending the expensive per-token RPC
// calls (holder count) or the Jupiter honeypot check on - it'll just get
// rechecked next tick in case the picture improves (holder % dilutes fast
// as more people buy in early on).
const PRELIMINARY_CONFIDENCE_FLOOR_PCT = 30;
// A single wallet holding this much of the supply essentially never dilutes
// back down to something reasonable within the alert window - rechecking
// candidates this bad every tick for up to maxTokenAgeSec is pure wasted
// RPC calls on something that was never going to pass. Reject once and move
// on, instead of re-fetching the same wallet's holdings repeatedly.
const HARD_REJECT_TOP1_PCT = 90;

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

    // These two facts are fixed at token creation and never change - unlike
    // liquidity or holder concentration, there is nothing to "recheck" here.
    // Bailing out before the holder-stats RPC call below is what actually
    // stops the bot from repeatedly looking up the same obviously-bad token
    // every tick until it ages out.
    if (settings.requireMintAuthorityRenounced && !mintInfo.mintAuthorityRenounced) {
      this.rejectPermanently(candidate, "mint authority not renounced - this never changes, not rechecking");
      return;
    }
    if (settings.requireFreezeAuthorityRenounced && !mintInfo.freezeAuthorityRenounced) {
      this.rejectPermanently(candidate, "freeze authority not renounced - this never changes, not rechecking");
      return;
    }

    const { top1Pct, top10Pct } = await getTopHolderStats(event.mint, mintInfo.supply);
    if (top1Pct >= HARD_REJECT_TOP1_PCT) {
      this.rejectPermanently(
        candidate,
        `top holder owns ${top1Pct.toFixed(1)}% - essentially certain dump risk, not rechecking`
      );
      return;
    }

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

    const { ok } = await sendTelegramMessage(html, { replyMarkup: buyButtonMarkup(event.mint) });
    alertStore.markAlerted(event.mint); // mark alerted regardless - don't spam-retry a send failure forever
    if (ok) {
      logger.info(`Alerted on ${event.symbol}: confidence ${score.matchConfidencePct}%, risk ${score.riskScore}/10`);
    }
  }

  logRejectionIfChanged(candidate, reason) {
    if (candidate.lastReason === reason) return;
    candidate.lastReason = reason;
    logger.info(`Not yet alerting on ${candidate.event.symbol} (rechecking): ${reason}`);
  }

  // For rejections that will never change their mind - removes the
  // candidate for good instead of leaving it in `pending` to be re-fetched
  // and re-scored on every tick until it ages out.
  rejectPermanently(candidate, reason) {
    this.pending.delete(candidate.event.mint);
    logger.info(`Dropped ${candidate.event.symbol}: ${reason}`);
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
