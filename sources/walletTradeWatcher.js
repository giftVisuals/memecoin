import { EventEmitter } from "node:events";
import { PublicKey } from "@solana/web3.js";
import { connection } from "../solanaConnection.js";
import { LAMPORTS_PER_SOL } from "../constants.js";
import { logger } from "../notify/logger.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";

// Watches specific wallets for buys using Solana's standard logsSubscribe -
// the same free Helius RPC quota already used for everything else in this
// bot, not a separate paid/metered service. Trade-off vs the old PumpPortal
// approach: PumpPortal handed us pre-parsed "wallet X bought token Y"
// events directly; this reads raw transaction logs and works out what
// happened from balance deltas instead. That's a bit more code, but it's
// free, and it actually catches a buy on ANY exchange (Jupiter, Raydium,
// pump.fun...), not just pump.fun trades.
export class WalletTradeWatcher extends EventEmitter {
  subscriptions = new Map(); // address -> subscriptionId

  start(addresses) {
    this.updateAddresses(addresses);
  }

  stop() {
    for (const subId of this.subscriptions.values()) {
      connection.removeOnLogsListener(subId).catch(() => {});
    }
    this.subscriptions.clear();
  }

  // Safe to call repeatedly with the same list - only subscribes to newly
  // added addresses and unsubscribes removed ones, no full reconnect needed
  // (unlike a single shared websocket subscription, each wallet here is its
  // own independent logsSubscribe).
  updateAddresses(addresses) {
    const desired = new Set(addresses);

    for (const [address, subId] of this.subscriptions) {
      if (desired.has(address)) continue;
      connection.removeOnLogsListener(subId).catch(() => {});
      this.subscriptions.delete(address);
    }

    for (const address of desired) {
      if (this.subscriptions.has(address)) continue;
      try {
        const subId = connection.onLogs(new PublicKey(address), (logInfo) => this.handleLog(address, logInfo), "confirmed");
        this.subscriptions.set(address, subId);
      } catch (err) {
        logger.error(`Could not subscribe to wallet ${address}: ${err.message}`);
      }
    }
  }

  async handleLog(address, logInfo) {
    if (logInfo.err) return; // failed transaction, nothing actually happened on-chain

    try {
      const tx = await connection.getParsedTransaction(logInfo.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!tx?.meta) return;

      const accountIndex = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === address);
      if (accountIndex === -1) return;

      // A buy means this wallet's own SOL balance went down (spent SOL,
      // possibly wrapped/unwrapped along the way - the net native balance
      // change captures it either way, fee included).
      const solDelta = (tx.meta.postBalances[accountIndex] - tx.meta.preBalances[accountIndex]) / LAMPORTS_PER_SOL;
      if (solDelta >= 0) return; // net SOL inflow or no change - not a buy from this wallet

      const preAmountByMint = new Map(
        (tx.meta.preTokenBalances ?? [])
          .filter((b) => b.owner === address)
          .map((b) => [b.mint, b.uiTokenAmount.uiAmount ?? 0])
      );

      // Whichever non-SOL token this wallet's balance increased in in this
      // same transaction is the token that got bought.
      let boughtMint = null;
      let boughtAmount = 0;
      for (const b of tx.meta.postTokenBalances ?? []) {
        if (b.owner !== address || b.mint === WSOL_MINT) continue;
        const pre = preAmountByMint.get(b.mint) ?? 0;
        const post = b.uiTokenAmount.uiAmount ?? 0;
        const delta = post - pre;
        if (delta > boughtAmount) {
          boughtAmount = delta;
          boughtMint = b.mint;
        }
      }
      if (!boughtMint) return; // no clear "received a new token" side to this transaction

      this.emit("walletTrade", {
        mint: boughtMint,
        trader: address,
        side: "buy",
        solAmount: -solDelta,
        tokenAmount: boughtAmount,
        seenAt: Date.now(),
      });
    } catch (err) {
      logger.error(`Failed to parse transaction ${logInfo.signature} for ${address}: ${err.message}`);
    }
  }
}
