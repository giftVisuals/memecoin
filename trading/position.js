import { getSettings } from "../settings.js";

// One open trade and its exit rules. Watchlisted ("big news") tokens get more
// room to run: a wider take-profit target and a longer max hold, per the
// "hold for coins like this more" instruction - everything else uses the
// standard, tighter rules since most new memecoins should be exited fast.
export class Position {
  constructor(params) {
    this.mint = params.mint;
    this.symbol = params.symbol;
    this.isWatchlisted = params.isWatchlisted;
    this.entryPriceSol = params.entryPriceSol;
    this.amountTokens = params.amountTokens;
    this.amountSolSpent = params.amountSolSpent;
    this.openedAt = params.openedAt;
    this.highWaterMarkPriceSol = params.entryPriceSol;
    this.lastPriceSol = params.entryPriceSol;

    const settings = getSettings();
    const multiplier = params.isWatchlisted ? settings.watchlistPositionMultiplier : 1;
    this.takeProfitPct = settings.takeProfitPct * (params.isWatchlisted ? 1.5 : 1);
    this.stopLossPct = settings.stopLossPct;
    this.trailingStopPct = settings.trailingStopPct;
    this.maxHoldTimeMs = settings.maxHoldTimeSec * 1000 * multiplier;
  }

  pnlPct(currentPriceSol) {
    return ((currentPriceSol - this.entryPriceSol) / this.entryPriceSol) * 100;
  }

  // Call on every price tick. Updates internal trailing state as a side
  // effect, so this must be called even when the caller ignores the result.
  evaluate(currentPriceSol, now) {
    this.lastPriceSol = currentPriceSol;
    if (currentPriceSol > this.highWaterMarkPriceSol) {
      this.highWaterMarkPriceSol = currentPriceSol;
    }

    const pnlPct = this.pnlPct(currentPriceSol);
    const dropFromHighPct =
      ((this.highWaterMarkPriceSol - currentPriceSol) / this.highWaterMarkPriceSol) * 100;

    if (pnlPct >= this.takeProfitPct) {
      return { shouldClose: true, reason: "take-profit" };
    }
    if (pnlPct <= -this.stopLossPct) {
      return { shouldClose: true, reason: "stop-loss" };
    }
    if (pnlPct > 0 && dropFromHighPct >= this.trailingStopPct) {
      return { shouldClose: true, reason: "trailing-stop" };
    }
    if (now - this.openedAt >= this.maxHoldTimeMs) {
      return { shouldClose: true, reason: "max-hold-time" };
    }

    return { shouldClose: false };
  }
}
