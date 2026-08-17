import { logger } from "../notify/logger.js";

const CACHE_MS = 5 * 60 * 1000;
let cached = { priceUsd: null, fetchedAt: 0 };

// Free, no key, generous rate limit - fine for a value we only refresh every
// few minutes. Used to turn bonding-curve SOL amounts into USD for Telegram
// alerts, which is what humans actually recognize at a glance.
export async function getSolUsdPrice() {
  if (cached.priceUsd && Date.now() - cached.fetchedAt < CACHE_MS) {
    return cached.priceUsd;
  }

  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const price = Number(body?.solana?.usd);
    if (!Number.isFinite(price) || price <= 0) throw new Error("bad response shape");
    cached = { priceUsd: price, fetchedAt: Date.now() };
    return price;
  } catch (err) {
    logger.warn(`Could not refresh SOL/USD price (${err.message}); using stale/fallback value.`);
    return cached.priceUsd ?? 150; // rough fallback so USD figures aren't just missing
  }
}
