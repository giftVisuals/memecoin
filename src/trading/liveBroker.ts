import { VersionedTransaction } from "@solana/web3.js";
import { connection, getMintInfo } from "../solanaConnection.js";
import { requireWallet } from "../wallet.js";
import { store } from "../persistence/store.js";
import { SOL_MINT, LAMPORTS_PER_SOL } from "../constants.js";
import type { Broker, BuyResult, SellResult } from "./broker.js";

const JUPITER_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_URL = "https://quote-api.jup.ag/v6/swap";
const SLIPPAGE_BPS = 1000; // 10% - wide on purpose, new pools are thin and volatile

interface JupiterQuote {
  outAmount: string;
  [key: string]: unknown;
}

async function getQuote(inputMint: string, outputMint: string, amountRaw: string): Promise<JupiterQuote> {
  const url = new URL(JUPITER_QUOTE_URL);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amountRaw);
  url.searchParams.set("slippageBps", String(SLIPPAGE_BPS));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as JupiterQuote;
}

async function executeSwap(quote: JupiterQuote, userPublicKey: string): Promise<string> {
  const wallet = requireWallet();

  const res = await fetch(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!res.ok) throw new Error(`Jupiter swap build failed: ${res.status} ${await res.text()}`);

  const { swapTransaction } = (await res.json()) as { swapTransaction: string };
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([wallet]);

  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");

  return signature;
}

// Real trades via Jupiter's swap aggregator. Only ever instantiated when
// TRADING_MODE=live and I_UNDERSTAND_THE_RISK=true (enforced in config.ts).
export class LiveBroker implements Broker {
  async getBalanceSol(): Promise<number> {
    const wallet = requireWallet();
    const lamports = await connection.getBalance(wallet.publicKey);
    return lamports / LAMPORTS_PER_SOL;
  }

  async buy(mint: string, symbol: string, priceSol: number, solAmount: number): Promise<BuyResult> {
    const wallet = requireWallet();
    const amountLamports = Math.round(solAmount * LAMPORTS_PER_SOL).toString();

    const quote = await getQuote(SOL_MINT, mint, amountLamports);
    const signature = await executeSwap(quote, wallet.publicKey.toBase58());

    const mintInfo = await getMintInfo(mint);
    const decimals = mintInfo?.decimals ?? 6;
    const amountTokens = Number(quote.outAmount) / 10 ** decimals;

    store.recordTrade({
      id: crypto.randomUUID(),
      mint,
      symbol,
      isWatchlisted: false,
      side: "buy",
      priceSol,
      amountTokens,
      amountSol: solAmount,
      reason: `tx:${signature}`,
      timestamp: new Date().toISOString(),
      mode: "live",
    });

    return { amountTokens, amountSolSpent: solAmount };
  }

  async sell(mint: string, symbol: string, priceSol: number, amountTokens: number): Promise<SellResult> {
    const wallet = requireWallet();
    const mintInfo = await getMintInfo(mint);
    const decimals = mintInfo?.decimals ?? 6;
    const amountRaw = Math.round(amountTokens * 10 ** decimals).toString();

    const quote = await getQuote(mint, SOL_MINT, amountRaw);
    const signature = await executeSwap(quote, wallet.publicKey.toBase58());

    const amountSolReceived = Number(quote.outAmount) / LAMPORTS_PER_SOL;

    store.recordTrade({
      id: crypto.randomUUID(),
      mint,
      symbol,
      isWatchlisted: false,
      side: "sell",
      priceSol,
      amountTokens,
      amountSol: amountSolReceived,
      reason: `tx:${signature}`,
      timestamp: new Date().toISOString(),
      mode: "live",
    });

    return { amountSolReceived };
  }
}
