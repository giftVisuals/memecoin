import { getSettings, parseRatchetLadder } from "../settings.js";

// One open trade and its exit rules. Watchlisted ("big news") tokens get more
// room to run: a longer max hold, per the "hold for coins like this more"
// instruction - everything else uses the standard, tighter rules since most
// new memecoins should be exited fast.
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

    // Ladder is snapshotted at open, same as every other exit rule here -
    // a mid-trade settings change shouldn't yank the floor out from under a
    // position that's already running.
    this.ratchetEnabled = settings.profitRatchetEnabled;
    this.ratchetLadder = parseRatchetLadder(settings.profitRatchetLadder);
    this.armedRung = null; // highest rung reached so far, once armed it never un-arms
  }

  pnlPct(currentPriceSol) {
    return ((currentPriceSol - this.entryPriceSol) / this.entryPriceSol) * 100;
  }

  // Call on every price tick. Updates internal trailing/ratchet state as a
  // side effect, so this must be called even when the caller ignores the
  // result.
  evaluate(currentPriceSol, now) {
    this.lastPriceSol = currentPriceSol;
    if (currentPriceSol > this.highWaterMarkPriceSol) {
      this.highWaterMarkPriceSol = currentPriceSol;
    }

    const pnlPct = this.pnlPct(currentPriceSol);

    // Stop-loss is a hard floor from the very start, ratchet or not - it
    // only ever fires below entry, so once the ratchet arms above breakeven
    // this simply never triggers again.
    if (pnlPct <= -this.stopLossPct) {
      return { shouldClose: true, reason: "stop-loss" };
    }

    if (this.ratchetEnabled && this.ratchetLadder.length > 0) {
      const highWaterMultiple = this.highWaterMarkPriceSol / this.entryPriceSol;
      const bestRung = [...this.ratchetLadder].reverse().find((r) => highWaterMultiple >= r.at);
      if (bestRung && (!this.armedRung || bestRung.at > this.armedRung.at)) {
        this.armedRung = bestRung;
      }

      if (this.armedRung) {
        let floorMultiple = this.armedRung.floor;

        // Past the last rung, keep giving room to run but claw back
        // trailingStopPct worth of the high instead of sitting flat at the
        // last rung's floor forever - so a 50X pump doesn't ride all the way
        // back down to an "8X floor" set when it first crossed 10X.
        const isTopRung = this.armedRung === this.ratchetLadder[this.ratchetLadder.length - 1];
        if (isTopRung) {
          const trailingFloorMultiple = highWaterMultiple * (1 - this.trailingStopPct / 100);
          floorMultiple = Math.max(floorMultiple, trailingFloorMultiple);
        }

        const floorPriceSol = this.entryPriceSol * floorMultiple;
        if (currentPriceSol <= floorPriceSol) {
          return {
            shouldClose: true,
            reason: `profit-ratchet (locked in ${floorMultiple.toFixed(2)}x after reaching ${highWaterMultiple.toFixed(2)}x)`,
          };
        }
        // Armed and above floor: let it keep running, skip the flat
        // take-profit/trailing-stop checks below entirely.
        if (now - this.openedAt >= this.maxHoldTimeMs) {
          return { shouldClose: true, reason: "max-hold-time" };
        }
        return { shouldClose: false };
      }
    }

    // Not armed yet (either the ratchet is off, or price hasn't reached the
    // first rung) - fall back to the original flat take-profit/trailing
    // behavior so small gains that never turn into a real pump don't get
    // held forever waiting for a 2X that isn't coming.
    if (!this.ratchetEnabled && pnlPct >= this.takeProfitPct) {
      return { shouldClose: true, reason: "take-profit" };
    }
    const dropFromHighPct =
      ((this.highWaterMarkPriceSol - currentPriceSol) / this.highWaterMarkPriceSol) * 100;
    if (pnlPct > 0 && dropFromHighPct >= this.trailingStopPct) {
      return { shouldClose: true, reason: "trailing-stop" };
    }
    if (now - this.openedAt >= this.maxHoldTimeMs) {
      return { shouldClose: true, reason: "max-hold-time" };
    }

    return { shouldClose: false };
  }
}
