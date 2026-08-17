import { getSettings } from "../settings.js";

// Each check is weighted by how much it actually matters for "will this rug
// or is it sellable" - sellability and holder concentration carry the most
// weight since those are the two ways a memecoin buyer actually loses
// everything. A check whose data wasn't available (holder count RPC failed,
// etc.) is simply left out of both the numerator and denominator rather than
// counted as a fail - an unknown shouldn't drag the score down as hard as a
// confirmed bad signal.
const WEIGHTS = {
  sellable: 3,
  mintRenounced: 2,
  freezeRenounced: 2,
  liquidityOk: 2,
  top1Ok: 2,
  top10Ok: 1,
  holderCountOk: 1,
};

export function scoreCandidate({ mintInfo, top1Pct, top10Pct, holderCount, liquiditySol, sellable }) {
  const f = getSettings();
  const checks = {};

  if (mintInfo) {
    checks.mintRenounced = mintInfo.mintAuthorityRenounced;
    checks.freezeRenounced = mintInfo.freezeAuthorityRenounced;
  }
  if (Number.isFinite(liquiditySol) && liquiditySol > 0) {
    checks.liquidityOk = liquiditySol >= f.minLiquiditySol;
  }
  if (Number.isFinite(top1Pct)) checks.top1Ok = top1Pct <= f.maxTopHolderPct;
  if (Number.isFinite(top10Pct)) checks.top10Ok = top10Pct <= f.maxTop10HolderPct;
  if (holderCount !== null && holderCount !== undefined) {
    checks.holderCountOk = holderCount >= f.minHolderCount;
  }
  if (sellable !== undefined) checks.sellable = sellable;

  let earned = 0;
  let possible = 0;
  for (const [key, passed] of Object.entries(checks)) {
    const weight = WEIGHTS[key];
    possible += weight;
    if (passed) earned += weight;
  }

  const fraction = possible > 0 ? earned / possible : 0;
  return {
    checks,
    matchConfidencePct: Math.round(fraction * 100),
    riskScore: Math.round((1 - fraction) * 10 * 10) / 10, // 0 = safest, 10 = riskiest
  };
}
