import { config } from "../config.js";
import { SOL_MINT } from "../constants.js";

const JUPITER_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";

// The single most important check: can we actually sell this token back to
// SOL? Plenty of memecoin contracts let you buy but block or tax sells into
// oblivion. We simulate a sell via Jupiter's quote API (no funds moved) and
// treat "no route" or extreme price impact as a honeypot signal.
export async function checkSellable(mint, decimals) {
  const nominalTokenAmount = 1000; // arbitrary small probe size
  const amount = BigInt(Math.round(nominalTokenAmount * 10 ** decimals)).toString();

  const url = new URL(JUPITER_QUOTE_URL);
  url.searchParams.set("inputMint", mint);
  url.searchParams.set("outputMint", SOL_MINT);
  url.searchParams.set("amount", amount);
  url.searchParams.set("slippageBps", "1000");

  let res;
  try {
    res = await fetch(url.toString());
  } catch (err) {
    return { sellable: false, priceImpactPct: 100, reason: `quote request failed: ${err}` };
  }

  if (!res.ok) {
    return { sellable: false, priceImpactPct: 100, reason: "no sell route found (likely honeypot)" };
  }

  const quote = await res.json();
  const outAmount = Number(quote.outAmount ?? 0);
  const priceImpactPct = Math.abs(Number(quote.priceImpactPct ?? 1)) * 100;

  if (outAmount <= 0) {
    return { sellable: false, priceImpactPct: 100, reason: "sell quote returned zero output" };
  }
  if (priceImpactPct > config.filters.maxSellPriceImpactPct) {
    return {
      sellable: false,
      priceImpactPct,
      reason: `sell price impact too high (${priceImpactPct.toFixed(1)}% > ${config.filters.maxSellPriceImpactPct}%)`,
    };
  }

  return { sellable: true, priceImpactPct };
}
