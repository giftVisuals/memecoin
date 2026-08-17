import { PublicKey } from "@solana/web3.js";
import { connection } from "../solanaConnection.js";
import { logger } from "../notify/logger.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// Cheap: getTokenLargestAccounts returns up to 20 holders in one call, which
// is all we need for top-1 and top-10 concentration. Safe to run on every
// candidate.
export async function getTopHolderStats(mint, supply) {
  if (supply === 0) return { top1Pct: 100, top10Pct: 100 };
  const largest = await connection.getTokenLargestAccounts(new PublicKey(mint));
  const accounts = largest.value ?? [];
  const top1 = Number(accounts[0]?.amount ?? 0);
  const top10 = accounts.slice(0, 10).reduce((sum, a) => sum + Number(a.amount), 0);
  return {
    top1Pct: (top1 / supply) * 100,
    top10Pct: (top10 / supply) * 100,
  };
}

// Expensive: has to scan every token account for this mint, which on a busy
// RPC can be slow or itself get rate-limited. Only called for candidates
// that already look promising (see signals/engine.js) so it doesn't burn
// quota on tokens about to be rejected anyway. Returns null (shown as
// "unknown" in the alert) rather than blocking the alert on failure.
export async function getHolderCount(mint) {
  try {
    const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }],
      dataSlice: { offset: 64, length: 8 }, // just the amount field, not the whole account
    });
    let holders = 0;
    for (const { account } of accounts) {
      const amount = account.data.readBigUInt64LE(0);
      if (amount > 0n) holders++;
    }
    return holders;
  } catch (err) {
    logger.warn(`Could not get holder count for ${mint}: ${err.message}`);
    return null;
  }
}
