import crypto from "node:crypto";
import { config } from "../config.js";

const ALGO = "aes-256-gcm";
const SALT = "g4scraper-wallet-key-v1";

function getKey() {
  if (!config.walletEncryptionKey) {
    throw new Error(
      "WALLET_ENCRYPTION_KEY is not set. Add it in Railway (any long random string) before adding wallets."
    );
  }
  return crypto.scryptSync(config.walletEncryptionKey, SALT, 32);
}

// Encrypted wallets are only ever readable with WALLET_ENCRYPTION_KEY, which
// stays in Railway env vars - never written to disk, never sent to the
// cloud backup. A leaked data/wallets.json (or its Upstash copy) is useless
// without it.
export function encryptSecret(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(payload) {
  const key = getKey();
  const [ivB64, authTagB64, dataB64] = payload.split(".");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const data = Buffer.from(dataB64, "base64");

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}
