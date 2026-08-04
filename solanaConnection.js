import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "./config.js";

export const connection = new Connection(config.wallet.rpcUrl, "confirmed");

export async function getMintInfo(mint) {
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const parsed = info.value?.data?.parsed;
  if (!parsed || parsed.type !== "mint") return null;

  const { mintAuthority, freezeAuthority, supply, decimals } = parsed.info;
  return {
    mintAuthorityRenounced: mintAuthority === null,
    freezeAuthorityRenounced: freezeAuthority === null,
    supply: Number(supply),
    decimals,
  };
}
