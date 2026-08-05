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

// These are awaited by their callers (store.js/settings.js/walletStore.js)
// before an add/remove/update reports success - otherwise a redeploy that
// lands in the gap between "saved locally" and "backup finished" would lose
// the change entirely, since the fresh container only has the cloud copy to
// restore from. Never throws - returns false on failure so the caller can
// decide whether to warn, but the local write (which already happened)
// stays valid for as long as this container is alive either way.
async function backup(key, content, label) {
  if (!enabled) return true;
  try {
    await upstashSet(key, content);
    return true;
  } catch (err) {
    logger.error(`Cloud backup (${label}) failed: ${err.message}`);
    return false;
  }
}

export function backupStore(content) {
  return backup(STORE_KEY, content, "store");
}

export function backupSettings(content) {
  return backup(SETTINGS_KEY, content, "settings");
}

export function backupWallets(content) {
  return backup(WALLETS_KEY, content, "wallets");
}
