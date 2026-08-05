import { VersionedTransaction } from "@solana/web3.js";
import { connection, getMintInfo } from "../solanaConnection.js";
import { store } from "../persistence/store.js";
import { SOL_MINT, LAMPORTS_PER_SOL } from "../constants.js";

const JUPITER_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_URL = "https://quote-api.jup.ag/v6/swap";
const SLIPPAGE_BPS = 1000; // 10% - wide on purpose, new pools are thin and volatile

async function getQuote(inputMint, outputMint, amountRaw) {
  const url = new URL(JUPITER_QUOTE_URL);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amountRaw);
  url.searchParams.set("slippageBps", String(SLIPPAGE_BPS));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function executeSwap(quote, keypair) {
  const res = await fetch(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!res.ok) throw new Error(`Jupiter swap build failed: ${res.status} ${await res.text()}`);

  const { swapTransaction } = await res.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([keypair]);

  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");

  return signature;
}

// Real trades via Jupiter's swap aggregator, signed with whichever keypair
// this instance was built with. Each wallet (primary or added) gets its own
// LiveBroker bound to its own keypair - never a shared global signer.
export class LiveBroker {
  constructor(keypair, walletId = "primary") {
    this.keypair = keypair;
    this.walletId = walletId;
  }

  async getBalanceSol() {
    const lamports = await connection.getBalance(this.keypair.publicKey);
    return lamports / LAMPORTS_PER_SOL;
  }

  async buy(mint, symbol, priceSol, solAmount) {
    const amountLamports = Math.round(solAmount * LAMPORTS_PER_SOL).toString();

    const quote = await getQuote(SOL_MINT, mint, amountLamports);
    const signature = await executeSwap(quote, this.keypair);

    const mintInfo = await getMintInfo(mint);
    const decimals = mintInfo?.decimals ?? 6;
    const amountTokens = Number(quote.outAmount) / 10 ** decimals;

    await store.recordTrade({
      id: crypto.randomUUID(),
      walletId: this.walletId,
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

  async sell(mint, symbol, priceSol, amountTokens) {
    const mintInfo = await getMintInfo(mint);
    const decimals = mintInfo?.decimals ?? 6;
    const amountRaw = Math.round(amountTokens * 10 ** decimals).toString();

    const quote = await getQuote(mint, SOL_MINT, amountRaw);
    const signature = await executeSwap(quote, this.keypair);

    const amountSolReceived = Number(quote.outAmount) / LAMPORTS_PER_SOL;

    await store.recordTrade({
      id: crypto.randomUUID(),
      walletId: this.walletId,
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
