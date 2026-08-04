import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";

export function loadWallet(): Keypair | null {
  if (!config.wallet.privateKey) return null;
  const secret = bs58.decode(config.wallet.privateKey);
  return Keypair.fromSecretKey(secret);
}

export function requireWallet(): Keypair {
  const wallet = loadWallet();
  if (!wallet) {
    throw new Error(
      "SOLANA_PRIVATE_KEY is not set. Run `npm run generate-wallet`, fund the printed address, " +
        "and set SOLANA_PRIVATE_KEY before using live mode."
    );
  }
  return wallet;
}
