import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const filePath = path.join(config.dataDir, "store.json");

function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(filePath)) {
    const initial = {
      paperBalanceSol: config.bankroll.startingPaperBalanceSol,
      trades: [],
    };
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function save(data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export const store = {
  getPaperBalance() {
    return load().paperBalanceSol;
  },

  setPaperBalance(balance) {
    const data = load();
    data.paperBalanceSol = balance;
    save(data);
  },

  recordTrade(trade) {
    const data = load();
    data.trades.push(trade);
    save(data);
  },

  getTrades() {
    return load().trades;
  },
};
