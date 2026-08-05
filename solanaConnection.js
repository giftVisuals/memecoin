import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "./config.js";

export const connection = new Connection(config.wallet.rpcUrl, "confirmed");

// Mint authority, freeze authority, supply, and decimals are all fixed at
// creation and don't change during a token's first few minutes (the only
// window this bot cares about) - caching them avoids re-spending RPC quota
// re-fetching identical data every time a pending candidate gets rechecked.
// Top holder % is deliberately NOT cached here (see safety/filters.js) -
// that one genuinely changes tick to tick and needs a fresh read.
const mintInfoCache = new Map();

export async function getMintInfo(mint) {
  const cached = mintInfoCache.get(mint);
  if (cached) return cached;

  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const parsed = info.value?.data?.parsed;
  if (!parsed || parsed.type !== "mint") return null;

  const { mintAuthority, freezeAuthority, supply, decimals } = parsed.info;
  const result = {
    mintAuthorityRenounced: mintAuthority === null,
    freezeAuthorityRenounced: freezeAuthority === null,
    supply: Number(supply),
    decimals,
  };
  mintInfoCache.set(mint, result);
  return result;
}
