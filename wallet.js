import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";

export function loadWallet() {
  if (!config.wallet.privateKey) return null;
  const secret = bs58.decode(config.wallet.privateKey);
  return Keypair.fromSecretKey(secret);
}

export function requireWallet() {
  const wallet = loadWallet();
  if (!wallet) {
    throw new Error(
      "SOLANA_PRIVATE_KEY is not set. Run `npm run generate-wallet`, fund the printed address, " +
        "and set SOLANA_PRIVATE_KEY before using live mode."
    );
  }
  return wallet;
}

// Generates a brand new keypair for the dashboard's "Generate Wallet" flow.
// Deliberately not persisted anywhere - the caller is responsible for
// showing the secret key to the user exactly once so they can save it and
// paste it into SOLANA_PRIVATE_KEY themselves.
export function generateNewWallet() {
  const keypair = Keypair.generate();
  return {
    address: keypair.publicKey.toBase58(),
    privateKeyBase58: bs58.encode(keypair.secretKey),
  };
}
