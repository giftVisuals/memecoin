import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "./config.js";

export const connection = new Connection(config.wallet.rpcUrl, "confirmed");

export interface MintInfo {
  mintAuthorityRenounced: boolean;
  freezeAuthorityRenounced: boolean;
  supply: number;
  decimals: number;
}

export async function getMintInfo(mint: string): Promise<MintInfo | null> {
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const parsed = (info.value?.data as any)?.parsed;
  if (!parsed || parsed.type !== "mint") return null;

  const { mintAuthority, freezeAuthority, supply, decimals } = parsed.info;
  return {
    mintAuthorityRenounced: mintAuthority === null,
    freezeAuthorityRenounced: freezeAuthority === null,
    supply: Number(supply),
    decimals,
  };
}
