import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { encryptSecret, decryptSecret } from "./walletCrypto.js";
import { backupWalletsAsync } from "./cloudBackup.js";

const filePath = path.join(config.dataDir, "wallets.json");

function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

let cache = null;

function load() {
  if (cache) return cache;
  ensureDataDir();
  if (!fs.existsSync(filePath)) {
    cache = [];
    return cache;
  }
  cache = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return cache;
}

function save(wallets) {
  ensureDataDir();
  const content = JSON.stringify(wallets, null, 2);
  fs.writeFileSync(filePath, content);
  backupWalletsAsync(content);
  cache = wallets;
}

// Additional trading wallets beyond the primary one (which still comes from
// SOLANA_PRIVATE_KEY, unmanaged by this store). Each entry's private key is
// encrypted at rest with WALLET_ENCRYPTION_KEY - see walletCrypto.js.
export const walletStore = {
  // Public-safe view - never includes the encrypted key material.
  list() {
    return load().map(({ encryptedSecretKey, ...rest }) => rest);
  },

  // Internal use only (engine needs the raw records to build signers).
  listRaw() {
    return load();
  },

  get(id) {
    return load().find((w) => w.id === id) ?? null;
  },

  // Generates a brand new keypair, stores it encrypted, and returns the
  // secret key exactly once so the caller can show it to the user as a
  // personal backup. It is never returned again after this call.
  addWallet(name) {
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    const privateKeyBase58 = bs58.encode(keypair.secretKey);

    const record = {
      id: crypto.randomUUID(),
      name: (name ?? "").trim() || "Unnamed",
      address,
      encryptedSecretKey: encryptSecret(privateKeyBase58),
      paused: true, // new wallets start paused - you opt them in deliberately
      createdAt: new Date().toISOString(),
    };

    const wallets = load();
    wallets.push(record);
    save(wallets);

    return { id: record.id, name: record.name, address, privateKeyBase58 };
  },

  removeWallet(id) {
    const wallets = load();
    const next = wallets.filter((w) => w.id !== id);
    if (next.length === wallets.length) throw new Error("Wallet not found");
    save(next);
  },

  setPaused(id, paused) {
    const wallets = load();
    const wallet = wallets.find((w) => w.id === id);
    if (!wallet) throw new Error("Wallet not found");
    wallet.paused = Boolean(paused);
    save(wallets);
    return wallet;
  },

  setName(id, name) {
    const wallets = load();
    const wallet = wallets.find((w) => w.id === id);
    if (!wallet) throw new Error("Wallet not found");
    wallet.name = (name ?? "").trim() || wallet.name;
    save(wallets);
    return wallet;
  },

  getKeypair(id) {
    const wallet = load().find((w) => w.id === id);
    if (!wallet) throw new Error("Wallet not found");
    const secretBase58 = decryptSecret(wallet.encryptedSecretKey);
    return Keypair.fromSecretKey(bs58.decode(secretBase58));
  },
};
