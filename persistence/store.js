import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { backupStoreAsync } from "./cloudBackup.js";

const filePath = path.join(config.dataDir, "store.json");
const PRIMARY = "primary";

function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(filePath)) {
    const initial = {
      paperBalances: { [PRIMARY]: config.bankroll.startingPaperBalanceSol },
      trades: [],
    };
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2));
    return initial;
  }

  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

  // Migrate the pre-multi-wallet shape ({ paperBalanceSol, trades }) in
  // place - older trades with no walletId are treated as the primary
  // wallet's, both here and everywhere else that reads trade.walletId.
  if (data.paperBalanceSol !== undefined && !data.paperBalances) {
    data.paperBalances = { [PRIMARY]: data.paperBalanceSol };
    delete data.paperBalanceSol;
  }
  if (!data.paperBalances) data.paperBalances = {};

  return data;
}

function save(data) {
  ensureDataDir();
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, content);
  backupStoreAsync(content);
}

function walletIdOf(trade) {
  return trade.walletId || PRIMARY;
}

export const store = {
  getPaperBalance(walletId = PRIMARY) {
    const data = load();
    return data.paperBalances[walletId] ?? config.bankroll.startingPaperBalanceSol;
  },

  setPaperBalance(walletId, balance) {
    const data = load();
    data.paperBalances[walletId] = balance;
    save(data);
  },

  recordTrade(trade) {
    const data = load();
    data.trades.push(trade);
    save(data);
  },

  getTrades(walletId) {
    const trades = load().trades;
    return walletId ? trades.filter((t) => walletIdOf(t) === walletId) : trades;
  },

  // Pairs each sell with the buy that opened it. Pairing happens per wallet
  // even when computing family-wide totals - two wallets independently
  // holding the same mint must never have their buys/sells cross-matched.
  getStats(walletId) {
    const allTrades = load().trades;
    const relevant = walletId ? allTrades.filter((t) => walletIdOf(t) === walletId) : allTrades;

    const byWallet = new Map();
    for (const trade of relevant) {
      const key = walletIdOf(trade);
      if (!byWallet.has(key)) byWallet.set(key, []);
      byWallet.get(key).push(trade);
    }

    let totalEarnedSol = 0;
    let totalLostSol = 0;
    let closedCount = 0;
    let winCount = 0;
    const tokensTradedSet = new Set();
    const closedTrades = [];

    for (const trades of byWallet.values()) {
      const sorted = [...trades].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      const openBuys = new Map();

      for (const trade of sorted) {
        if (trade.side === "buy") {
          openBuys.set(trade.mint, trade);
          tokensTradedSet.add(trade.mint);
        } else if (trade.side === "sell") {
          const buy = openBuys.get(trade.mint);
          if (buy) {
            const pnlSol = trade.amountSol - buy.amountSol;
            closedCount++;
            if (pnlSol > 0) {
              totalEarnedSol += pnlSol;
              winCount++;
            } else if (pnlSol < 0) {
              totalLostSol += Math.abs(pnlSol);
            }
            closedTrades.push({
              mint: trade.mint,
              symbol: trade.symbol,
              walletId: walletIdOf(trade),
              pnlSol,
              closedAt: trade.timestamp,
            });
            openBuys.delete(trade.mint);
          }
        }
      }
    }

    closedTrades.sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));

    return {
      tokensTraded: tokensTradedSet.size,
      closedTrades: closedCount,
      winRate: closedCount ? (winCount / closedCount) * 100 : 0,
      totalEarnedSol,
      totalLostSol,
      netPnlSol: totalEarnedSol - totalLostSol,
      recentClosedTrades: closedTrades.slice(0, 20),
    };
  },
};
