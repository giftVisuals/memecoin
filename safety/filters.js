import { PublicKey } from "@solana/web3.js";
import { getSettings } from "../settings.js";
import { connection, getMintInfo } from "../solanaConnection.js";

async function getTopHolderPct(mint, supply) {
  if (supply === 0) return 100;
  const largest = await connection.getTokenLargestAccounts(new PublicKey(mint));
  const top = largest.value[0];
  if (!top) return 0;
  return (Number(top.amount) / supply) * 100;
}

// Runs every configured safety check for a candidate token. All of them must
// pass before the engine is allowed to buy - this is what "sharp and
// sensitive" actually means in code: reject far more than it accepts.
export async function runSafetyFilters(mint, pair, ageSec) {
  const reasons = [];
  const f = getSettings();

  if (ageSec < f.minTokenAgeSec) {
    reasons.push(`too new (${ageSec}s < ${f.minTokenAgeSec}s minimum - let the dust settle)`);
  }
  if (ageSec > f.maxTokenAgeSec) {
    reasons.push(`too old (${ageSec}s > ${f.maxTokenAgeSec}s window - momentum likely already spent)`);
  }
  if (pair.liquiditySol < f.minLiquiditySol) {
    reasons.push(`liquidity too low (${pair.liquiditySol.toFixed(2)} SOL < ${f.minLiquiditySol} SOL)`);
  }

  const mintInfo = await getMintInfo(mint);
  if (!mintInfo) {
    reasons.push("could not read mint account (RPC issue or invalid mint)");
  } else {
    if (f.requireMintAuthorityRenounced && !mintInfo.mintAuthorityRenounced) {
      reasons.push("mint authority not renounced (dev can mint unlimited supply)");
    }
    if (f.requireFreezeAuthorityRenounced && !mintInfo.freezeAuthorityRenounced) {
      reasons.push("freeze authority not renounced (dev can freeze your tokens)");
    }

    const topHolderPct = await getTopHolderPct(mint, mintInfo.supply);
    if (topHolderPct > f.maxTopHolderPct) {
      reasons.push(
        `top holder owns ${topHolderPct.toFixed(1)}% (> ${f.maxTopHolderPct}% max - likely dump risk)`
      );
    }
  }

  return { passed: reasons.length === 0, reasons };
}
