import { store } from "../persistence/store.js";
import type { Broker, BuyResult, SellResult } from "./broker.js";

// Simulated slippage so paper results aren't unrealistically clean - real
// swaps on brand-new low-liquidity pools rarely fill at the quoted price.
const SIMULATED_SLIPPAGE_PCT = 2;

export class PaperBroker implements Broker {
  async getBalanceSol(): Promise<number> {
    return store.getPaperBalance();
  }

  async buy(mint: string, symbol: string, priceSol: number, solAmount: number): Promise<BuyResult> {
    const balance = store.getPaperBalance();
    if (solAmount > balance) {
      throw new Error(`Paper balance too low: have ${balance} SOL, need ${solAmount} SOL`);
    }
    const effectivePrice = priceSol * (1 + SIMULATED_SLIPPAGE_PCT / 100);
    const amountTokens = solAmount / effectivePrice;

    store.setPaperBalance(balance - solAmount);
    store.recordTrade({
      id: crypto.randomUUID(),
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

  async sell(mint: string, symbol: string, priceSol: number, amountTokens: number): Promise<SellResult> {
    const effectivePrice = priceSol * (1 - SIMULATED_SLIPPAGE_PCT / 100);
    const amountSolReceived = amountTokens * effectivePrice;

    const balance = store.getPaperBalance();
    store.setPaperBalance(balance + amountSolReceived);
    store.recordTrade({
      id: crypto.randomUUID(),
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
