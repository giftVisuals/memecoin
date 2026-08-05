import { store } from "../persistence/store.js";

// Simulated slippage so paper results aren't unrealistically clean - real
// swaps on brand-new low-liquidity pools rarely fill at the quoted price.
const SIMULATED_SLIPPAGE_PCT = 2;

export class PaperBroker {
  constructor(walletId = "primary") {
    this.walletId = walletId;
  }

  async getBalanceSol() {
    return store.getPaperBalance(this.walletId);
  }

  async buy(mint, symbol, priceSol, solAmount) {
    const balance = store.getPaperBalance(this.walletId);
    if (solAmount > balance) {
      throw new Error(`Paper balance too low: have ${balance} SOL, need ${solAmount} SOL`);
    }
    const effectivePrice = priceSol * (1 + SIMULATED_SLIPPAGE_PCT / 100);
    const amountTokens = solAmount / effectivePrice;

    store.setPaperBalance(this.walletId, balance - solAmount);
    store.recordTrade({
      id: crypto.randomUUID(),
      walletId: this.walletId,
      mint,
      symbol,
      isWatchlisted: false,
      side: "buy",
      priceSol: effectivePrice,
      amountTokens,
      amountSol: solAmount,
      timestamp: new Date().toISOString(),
      mode: "paper",
    });

    return { amountTokens, amountSolSpent: solAmount };
  }

  async sell(mint, symbol, priceSol, amountTokens) {
    const effectivePrice = priceSol * (1 - SIMULATED_SLIPPAGE_PCT / 100);
    const amountSolReceived = amountTokens * effectivePrice;

    const balance = store.getPaperBalance(this.walletId);
    store.setPaperBalance(this.walletId, balance + amountSolReceived);
    store.recordTrade({
      id: crypto.randomUUID(),
      walletId: this.walletId,
      mint,
      symbol,
      isWatchlisted: false,
      side: "sell",
      priceSol: effectivePrice,
      amountTokens,
      amountSol: amountSolReceived,
      timestamp: new Date().toISOString(),
      mode: "paper",
    });

    return { amountSolReceived };
  }
}
