import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const keypair = Keypair.generate();

console.log("New Solana wallet generated.\n");
console.log("Public address (fund this with your $5-10 in SOL):");
console.log(keypair.publicKey.toBase58());
console.log("\nSecret key (set this as SOLANA_PRIVATE_KEY - a Railway env var, NEVER commit it):");
console.log(bs58.encode(keypair.secretKey));
console.log(
  "\nThis key is only printed here, once. Nothing is saved to disk. Copy it somewhere safe now."
);
