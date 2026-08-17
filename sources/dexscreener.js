import { config } from "../config.js";

// DexScreener's public REST API - free, no key, used to enrich a mint with
// liquidity/price/age data once it's been discovered by the pump.fun feed.
// Brand new tokens can take a little while to get indexed, so callers should
// retry/backoff rather than treat a miss as permanent.
export async function fetchPairData(mint) {
  const url = `${config.sources.dexscreenerApiUrl}/latest/dex/tokens/${mint}`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const body = await res.json();
  const pairs = (body.pairs ?? []).filter((p) => p.chainId === "solana");
  if (pairs.length === 0) return null;

  const best = pairs.reduce((a, b) =>
    (a.liquidity?.usd ?? 0) >= (b.liquidity?.usd ?? 0) ? a : b
  );

  const isSolQuote = best.quoteToken?.symbol?.toUpperCase() === "SOL";
  const liquiditySol = isSolQuote ? best.liquidity?.quote ?? 0 : 0;

  return {
    pairAddress: best.pairAddress,
    priceSol: Number(best.priceNative ?? 0),
    liquiditySol,
    liquidityUsd: best.liquidity?.usd ?? 0,
    fdvUsd: best.fdv ?? 0,
    pairCreatedAt: best.pairCreatedAt ?? Date.now(),
    volume24hUsd: best.volume?.h24 ?? 0,
  };
}
