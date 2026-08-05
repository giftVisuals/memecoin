import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { encryptSecret, decryptSecret } from "./walletCrypto.js";
import { backupWallets } from "./cloudBackup.js";
import { logger } from "../notify/logger.js";

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

// Awaited by every write below - by the time addWallet/removeWallet/etc.
// return, the cloud copy is either confirmed saved or we've logged loudly
// that it wasn't. Without this, a redeploy landing right after a wallet was
// added (before a fire-and-forget backup finished) could lose it entirely.
async function save(wallets) {
  ensureDataDir();
  const content = JSON.stringify(wallets, null, 2);
  fs.writeFileSync(filePath, content);
  cache = wallets;
  const backedUp = await backupWallets(content);
  if (!backedUp) {
    logger.error(
      "Wallet change saved locally but NOT backed up to the cloud - it will be lost if this " +
        "container redeploys or restarts before the next successful backup."
    );
  }
  return backedUp;
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
  async addWallet(name) {
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
    const backedUp = await save(wallets);

    return { id: record.id, name: record.name, address, privateKeyBase58, backedUp };
  },

  async removeWallet(id) {
    const wallets = load();
    const next = wallets.filter((w) => w.id !== id);
    if (next.length === wallets.length) throw new Error("Wallet not found");
    await save(next);
  },

  async setPaused(id, paused) {
    const wallets = load();
    const wallet = wallets.find((w) => w.id === id);
    if (!wallet) throw new Error("Wallet not found");
    wallet.paused = Boolean(paused);
    await save(wallets);
    return wallet;
  },

  async setName(id, name) {
    const wallets = load();
    const wallet = wallets.find((w) => w.id === id);
    if (!wallet) throw new Error("Wallet not found");
    wallet.name = (name ?? "").trim() || wallet.name;
    await save(wallets);
    return wallet;
  },

  getKeypair(id) {
    const wallet = load().find((w) => w.id === id);
    if (!wallet) throw new Error("Wallet not found");
    const secretBase58 = decryptSecret(wallet.encryptedSecretKey);
    return Keypair.fromSecretKey(bs58.decode(secretBase58));
  },
};
