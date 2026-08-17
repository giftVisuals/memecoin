// Token names/symbols come straight from pump.fun and are attacker-controlled
// (anyone can name a token anything) - escaped before going into an HTML
// parse_mode Telegram message so a malicious name can't inject markup or a
// fake link into the alert.
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtUsd(n) {
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function emoji(bool) {
  if (bool === undefined) return "❔";
  return bool ? "✅" : "❌";
}

// Shared block used by every alert type (new-token, smart-wallet-buy, and
// later CT signal), so they all stay visually consistent.
export function tokenStatsBlock({
  liquidityUsd,
  marketCapUsd,
  holderCount,
  top10Pct,
  checks,
  riskScore,
  matchConfidencePct,
}) {
  return [
    `💧 Liquidity: ${fmtUsd(liquidityUsd)}`,
    `📊 Market cap: ${fmtUsd(marketCapUsd)}`,
    `👥 Holders: ${holderCount ?? "unknown"}`,
    `🐋 Top 10 hold: ${Number.isFinite(top10Pct) ? top10Pct.toFixed(1) + "%" : "unknown"}`,
    // Every candidate here comes straight from pump.fun's bonding curve,
    // which is program-owned by construction (the creator can't pull it) -
    // this isn't a traditional "LP lock" check, it's just always true for
    // any token this bot can even see. A migrated/Raydium LP-burn check
    // would be a separate, real check - not built yet.
    `🔒 LP locked: ✅ (bonding curve - program owned)`,
    `🖊️ Mint renounced: ${emoji(checks.mintRenounced)}`,
    `🧊 Freeze renounced: ${emoji(checks.freezeRenounced)}`,
    `🔁 Sellable: ${emoji(checks.sellable)}`,
    `⚠️ Risk score: ${riskScore}/10`,
    `🎯 Match confidence: ${matchConfidencePct}%`,
  ].join("\n");
}

export function formatNewTokenAlert({ event, mint, liquidityUsd, marketCapUsd, holderCount, top10Pct, score }) {
  const name = escapeHtml(event.name);
  const symbol = escapeHtml(event.symbol);
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  return [
    `🚨 NEW TOKEN SIGNAL`,
    ``,
    `🪙 Token: ${name} (${symbol})`,
    `📜 CA: <code>${mint}</code>`,
    ``,
    tokenStatsBlock({ liquidityUsd, marketCapUsd, holderCount, top10Pct, ...score }),
    ``,
    `<a href="https://dexscreener.com/solana/${mint}">DexScreener</a> | <a href="https://birdeye.so/token/${mint}?chain=solana">Birdeye</a>`,
    ``,
    `🕒 ${timestamp}`,
    ``,
    `Not financial advice. DYOR before buying.`,
  ].join("\n");
}

function shortAddress(address) {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function pnlLine(pnlPct) {
  const arrow = pnlPct > 0 ? "📈" : pnlPct < 0 ? "📉" : "➖";
  const sign = pnlPct > 0 ? "+" : "";
  return `${arrow} PnL: ${sign}${pnlPct.toFixed(1)}%`;
}

// Replaces the original alert in place after a Buy Now tap. Deliberately
// drops the original risk-score stats block - those mattered for the buy
// decision, not for tracking a position you already opened - in favor of a
// compact card that's easy to re-edit every price tick.
export function formatOpenPositionCard({ symbol, mint, entryPriceSol, currentPriceSol, pnlPct, amountSolSpent }) {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  return [
    `✅ BOUGHT ${escapeHtml(symbol)}`,
    ``,
    `📜 CA: <code>${mint}</code>`,
    `💵 Entry: ${entryPriceSol.toFixed(10)} SOL (spent ${amountSolSpent.toFixed(4)} SOL)`,
    `💲 Current: ${currentPriceSol.toFixed(10)} SOL`,
    pnlLine(pnlPct),
    ``,
    `🕒 Updated ${timestamp}`,
  ].join("\n");
}

export function formatClosedPositionCard({ symbol, mint, entryPriceSol, exitPriceSol, pnlPct, pnlSol, amountSolSpent }) {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const sign = pnlSol >= 0 ? "+" : "";
  return [
    `🏁 SOLD ${escapeHtml(symbol)}`,
    ``,
    `📜 CA: <code>${mint}</code>`,
    `💵 Entry: ${entryPriceSol.toFixed(10)} SOL (spent ${amountSolSpent.toFixed(4)} SOL)`,
    `💲 Exit: ${exitPriceSol.toFixed(10)} SOL`,
    `${pnlLine(pnlPct)} (${sign}${pnlSol.toFixed(4)} SOL)`,
    ``,
    `🕒 Closed ${timestamp}`,
  ].join("\n");
}

export function formatBuyFailedNote(reason) {
  return `\n\n❌ Buy failed: ${escapeHtml(reason)}. Tap Buy Now to retry.`;
}

export function formatWhaleBuyAlert({
  walletLabel,
  walletAddress,
  mint,
  name,
  symbol,
  liquidityUsd,
  marketCapUsd,
  holderCount,
  top10Pct,
  score,
  solSpent,
}) {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  return [
    `🐋 SMART WALLET BUY`,
    ``,
    `👤 Wallet: ${escapeHtml(walletLabel)} (<code>${shortAddress(walletAddress)}</code>)`,
    `💰 Bought: ${solSpent.toFixed(3)} SOL`,
    ``,
    `🪙 Token: ${escapeHtml(name)} (${escapeHtml(symbol)})`,
    `📜 CA: <code>${mint}</code>`,
    ``,
    tokenStatsBlock({ liquidityUsd, marketCapUsd, holderCount, top10Pct, ...score }),
    ``,
    `<a href="https://dexscreener.com/solana/${mint}">DexScreener</a> | <a href="https://birdeye.so/token/${mint}?chain=solana">Birdeye</a> | <a href="https://solscan.io/account/${walletAddress}">Wallet on Solscan</a>`,
    ``,
    `🕒 ${timestamp}`,
    ``,
    `Not financial advice. DYOR before buying.`,
  ].join("\n");
}
