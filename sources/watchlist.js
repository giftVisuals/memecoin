import { config } from "../config.js";

// Honest scope note: there is no free, reliable way to watch the live
// Twitter/X firehose for "a notable person just launched a coin" - real-time
// access to that requires a paid API tier and still isn't instant. Instead we
// match new token name/symbol against a keyword watchlist (config.watchlist),
// which is what actually catches things like a token literally named
// "TRUMP" or "MELANIA" at launch. Treat this as a heuristic, not surveillance.
export function isWatchlisted(name, symbol) {
  const haystack = `${name} ${symbol}`.toLowerCase();
  return config.watchlist.keywords.some((keyword) => haystack.includes(keyword));
}
