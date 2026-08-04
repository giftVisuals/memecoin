import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export interface TradeRecord {
  id: string;
  mint: string;
  symbol: string;
  isWatchlisted: boolean;
  side: "buy" | "sell";
  priceSol: number;
  amountTokens: number;
  amountSol: number;
  reason?: string;
  timestamp: string;
  mode: "paper" | "live";
}

interface StoreShape {
  paperBalanceSol: number;
  trades: TradeRecord[];
}

const filePath = path.join(config.dataDir, "store.json");

function ensureDataDir(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function load(): StoreShape {
  ensureDataDir();
  if (!fs.existsSync(filePath)) {
    const initial: StoreShape = {
      paperBalanceSol: config.bankroll.startingPaperBalanceSol,
      trades: [],
    };
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as StoreShape;
}

function save(data: StoreShape): void {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export const store = {
  getPaperBalance(): number {
    return load().paperBalanceSol;
  },

  setPaperBalance(balance: number): void {
    const data = load();
    data.paperBalanceSol = balance;
    save(data);
  },

  recordTrade(trade: TradeRecord): void {
    const data = load();
    data.trades.push(trade);
    save(data);
  },

  getTrades(): TradeRecord[] {
    return load().trades;
  },
};
