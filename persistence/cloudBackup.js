import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../notify/logger.js";

const STORE_KEY = "g4scraper:store";
const SETTINGS_KEY = "g4scraper:settings";
const WALLETS_KEY = "g4scraper:wallets";

const storeFilePath = path.join(config.dataDir, "store.json");
const settingsFilePath = path.join(config.dataDir, "settings.json");
const walletsFilePath = path.join(config.dataDir, "wallets.json");

export const enabled = Boolean(config.cloudBackup.url && config.cloudBackup.token);

async function upstashGet(key) {
  const res = await fetch(`${config.cloudBackup.url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${config.cloudBackup.token}` },
  });
  if (!res.ok) throw new Error(`Upstash GET ${key} failed: ${res.status}`);
  const body = await res.json();
  return body.result; // string, or null if the key doesn't exist yet
}

async function upstashSet(key, value) {
  const res = await fetch(`${config.cloudBackup.url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.cloudBackup.token}`,
      "Content-Type": "text/plain",
    },
    body: value,
  });
  if (!res.ok) throw new Error(`Upstash SET ${key} failed: ${res.status}`);
}

async function restoreOne(cloudKey, filePath, label) {
  if (fs.existsSync(filePath)) return; // local copy is newer than any cloud snapshot
  const data = await upstashGet(cloudKey);
  if (data) {
    fs.writeFileSync(filePath, data);
    logger.info(`Restored ${label} from cloud backup`);
  }
}

// Called once at boot, before anything reads data/*.json. Only restores a
// file that's actually missing locally - if the container already has a
// local copy (a plain restart rather than a fresh redeploy), that's newer
// than any cloud snapshot and we leave it alone.
export async function restoreFromCloud() {
  if (!enabled) return;
  fs.mkdirSync(config.dataDir, { recursive: true });

  try {
    await restoreOne(STORE_KEY, storeFilePath, "trade history");
    await restoreOne(SETTINGS_KEY, settingsFilePath, "settings");
    await restoreOne(WALLETS_KEY, walletsFilePath, "wallets");
  } catch (err) {
    logger.error(`Cloud restore failed, starting fresh: ${err.message}`);
  }
}

// Fire-and-forget - called after every local write so the cloud copy never
// falls far behind, without making trade/settings/wallet writes wait on a
// network round trip. Wallet contents are already encrypted before this is
// called (see walletCrypto.js) - Upstash only ever sees ciphertext.
export function backupStoreAsync(content) {
  if (!enabled) return;
  upstashSet(STORE_KEY, content).catch((err) => logger.error(`Cloud backup (store) failed: ${err.message}`));
}

export function backupSettingsAsync(content) {
  if (!enabled) return;
  upstashSet(SETTINGS_KEY, content).catch((err) =>
    logger.error(`Cloud backup (settings) failed: ${err.message}`)
  );
}

export function backupWalletsAsync(content) {
  if (!enabled) return;
  upstashSet(WALLETS_KEY, content).catch((err) =>
    logger.error(`Cloud backup (wallets) failed: ${err.message}`)
  );
}
