import { getSettings } from "../settings.js";

// Honest scope note: there is no free, reliable way to watch the live
// Twitter/X firehose for "a notable person just launched a coin" - real-time
// access to that requires a paid API tier and still isn't instant. Instead we
// match new token name/symbol against a keyword watchlist (editable from the
// dashboard), which is what actually catches things like a token literally
// named "TRUMP" or "MELANIA" at launch. Treat this as a heuristic, not
// surveillance - and note it can be gamed by copycat/troll tokens riding on a
// name, which is exactly why watchlist status only affects sizing/hold time
// and never bypasses the safety filters below.
export function isWatchlisted(name, symbol) {
  const haystack = `${name} ${symbol}`.toLowerCase();
  return getSettings().watchlistKeywords.some((keyword) => haystack.includes(keyword));
}
