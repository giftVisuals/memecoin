export interface BuyResult {
  amountTokens: number;
  amountSolSpent: number;
}

export interface SellResult {
  amountSolReceived: number;
}

export interface Broker {
  getBalanceSol(): Promise<number>;
  buy(mint: string, symbol: string, priceSol: number, solAmount: number): Promise<BuyResult>;
  sell(mint: string, symbol: string, priceSol: number, amountTokens: number): Promise<SellResult>;
}
