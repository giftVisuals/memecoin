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
  // A liquiditySol of exactly 0 is NOT treated as "confirmed zero liquidity"
  // here - DexScreener doesn't reliably report liquidity for pump.fun tokens
  // still on the bonding curve (pre-Raydium-migration), which is every
  // candidate in our buy window, since migration takes far longer than 180
  // seconds. Hard-blocking on that unverifiable "0" was rejecting every
  // single candidate regardless of the configured threshold. Real
  // tradability for these tokens is verified downstream instead, by the
  // honeypot/sellability check asking Jupiter directly whether a sell route
  // exists - a much more direct signal than a field DexScreener doesn't
  // populate at this stage.
  if (pair.liquiditySol > 0 && pair.liquiditySol < f.minLiquiditySol) {
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

  // Returned so callers (the honeypot check needs decimals) can reuse this
  // instead of fetching the same mint account from the RPC a second time.
  return { passed: reasons.length === 0, reasons, mintInfo };
}
