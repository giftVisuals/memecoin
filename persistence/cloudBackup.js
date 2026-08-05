import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../notify/logger.js";

const STORE_KEY = "g4scraper:store";
const SETTINGS_KEY = "g4scraper:settings";

const storeFilePath = path.join(config.dataDir, "store.json");
const settingsFilePath = path.join(config.dataDir, "settings.json");

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

// Called once at boot, before anything reads data/*.json. Only restores a
// file that's actually missing locally - if the container already has a
// local copy (a plain restart rather than a fresh redeploy), that's newer
// than any cloud snapshot and we leave it alone.
export async function restoreFromCloud() {
  if (!enabled) return;
  fs.mkdirSync(config.dataDir, { recursive: true });

  try {
    if (!fs.existsSync(storeFilePath)) {
      const storeData = await upstashGet(STORE_KEY);
      if (storeData) {
        fs.writeFileSync(storeFilePath, storeData);
        logger.info("Restored trade history from cloud backup");
      }
    }
    if (!fs.existsSync(settingsFilePath)) {
      const settingsData = await upstashGet(SETTINGS_KEY);
      if (settingsData) {
        fs.writeFileSync(settingsFilePath, settingsData);
        logger.info("Restored settings from cloud backup");
      }
    }
  } catch (err) {
    logger.error(`Cloud restore failed, starting fresh: ${err.message}`);
  }
}

// Fire-and-forget - called after every local write so the cloud copy never
// falls far behind, without making trade/settings writes wait on a network
// round trip.
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
