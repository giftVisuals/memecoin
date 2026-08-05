import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { backupStoreAsync } from "./cloudBackup.js";

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
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, content);
  backupStoreAsync(content);
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

  // Pairs each sell with the buy that opened it (one open position per mint
  // at a time, so a simple last-buy-per-mint pairing is correct here) and
  // rolls that up into the numbers the dashboard home page shows.
  getStats() {
    const trades = [...load().trades].sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );

    const openBuys = new Map();
    const closedTrades = [];

    for (const trade of trades) {
      if (trade.side === "buy") {
        openBuys.set(trade.mint, trade);
      } else if (trade.side === "sell") {
        const buy = openBuys.get(trade.mint);
        if (buy) {
          closedTrades.push({
            mint: trade.mint,
            symbol: trade.symbol,
            pnlSol: trade.amountSol - buy.amountSol,
            closedAt: trade.timestamp,
          });
          openBuys.delete(trade.mint);
        }
      }
    }

    const totalEarnedSol = closedTrades
      .filter((t) => t.pnlSol > 0)
      .reduce((sum, t) => sum + t.pnlSol, 0);
    const totalLostSol = closedTrades
      .filter((t) => t.pnlSol < 0)
      .reduce((sum, t) => sum + Math.abs(t.pnlSol), 0);
    const uniqueMintsBought = new Set(trades.filter((t) => t.side === "buy").map((t) => t.mint)).size;

    return {
      tokensTraded: uniqueMintsBought,
      closedTrades: closedTrades.length,
      winRate: closedTrades.length
        ? (closedTrades.filter((t) => t.pnlSol > 0).length / closedTrades.length) * 100
        : 0,
      totalEarnedSol,
      totalLostSol,
      netPnlSol: totalEarnedSol - totalLostSol,
      recentClosedTrades: closedTrades.slice(-20).reverse(),
    };
  },
};
