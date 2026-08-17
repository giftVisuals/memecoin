import { getSettings } from "../settings.js";
import { logger } from "../notify/logger.js";
import { loadWallet, requireWallet } from "../wallet.js";
import { connection } from "../solanaConnection.js";
import { LAMPORTS_PER_SOL } from "../constants.js";
import { LiveBroker } from "../trading/liveBroker.js";
import { store } from "../persistence/store.js";
import { fetchPairData } from "../sources/dexscreener.js";
import {
  telegramEnabled,
  editTelegramMessage,
  answerCallbackQuery,
  getTelegramUpdates,
} from "../notify/telegram.js";
import { formatOpenPositionCard, formatClosedPositionCard, formatBuyFailedNote } from "./format.js";

const WALLET_ID = "telegram"; // keeps button-bought trades separate/identifiable in store.json
const PRICE_TICK_MS = 20_000;
const PNL_EDIT_THRESHOLD_PCT = 0.1; // don't re-edit Telegram for noise-level price wiggle

export function buyButtonMarkup(mint) {
  return { inline_keyboard: [[{ text: "🟢 Buy Now", callback_data: `buy:${mint}` }]] };
}

function sellButtonMarkup(mint) {
  return { inline_keyboard: [[{ text: "🔴 Sell Now", callback_data: `sell:${mint}` }]] };
}

// Turns Telegram alerts into one-tap real trades. Buy Now executes a real
// swap with the same Main wallet used by paper/live mode (SOLANA_PRIVATE_KEY)
// and the dashboard's Position Size setting; Sell Now closes it. Nothing
// here runs unless Telegram is configured - entirely inert (and funds-safe)
// otherwise.
class ManualTradingController {
  openPositions = new Map(); // mint -> { symbol, entryPriceSol, amountTokens, amountSolSpent, openedAt, chatId, messageId, lastShownPnlPct }
  buyLocks = new Set();
  sellLocks = new Set();
  pollOffset = undefined;
  polling = false;
  tickHandle = null;

  async start() {
    if (!telegramEnabled) return; // nothing to poll, nothing to click

    this.polling = true;
    this.pollLoop().catch((err) => logger.error(`Telegram poll loop crashed: ${err.message}`));
    this.tickHandle = setInterval(() => {
      this.refreshOpenPositions().catch((err) => logger.error(`Position price refresh failed: ${err.message}`));
    }, PRICE_TICK_MS);
  }

  stop() {
    this.polling = false;
    if (this.tickHandle) clearInterval(this.tickHandle);
  }

  async pollLoop() {
    let backoffMs = 2000;
    while (this.polling) {
      try {
        const updates = await getTelegramUpdates(this.pollOffset);
        for (const update of updates) {
          this.pollOffset = update.update_id + 1;
          if (update.callback_query) {
            this.handleCallbackQuery(update.callback_query).catch((err) =>
              logger.error(`Handling Telegram button tap failed: ${err.message}`)
            );
          }
        }
        backoffMs = 2000; // reset after a clean round
      } catch (err) {
        logger.error(`Telegram getUpdates failed: ${err.message}`);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  async handleCallbackQuery(query) {
    const [action, mint] = String(query.data ?? "").split(":");
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (action === "buy") {
      await answerCallbackQuery(query.id, "Buying...");
      await this.handleBuy(mint, chatId, messageId);
    } else if (action === "sell") {
      await answerCallbackQuery(query.id, "Selling...");
      await this.handleSell(mint, chatId, messageId);
    } else {
      await answerCallbackQuery(query.id, "Unknown action");
    }
  }

  async handleBuy(mint, chatId, messageId) {
    if (this.openPositions.has(mint)) {
      await editTelegramMessage(chatId, messageId, `Already holding this one - use Sell Now to close it.`, {
        replyMarkup: sellButtonMarkup(mint),
      });
      return;
    }
    if (this.buyLocks.has(mint)) return; // duplicate tap while a buy is already in flight
    this.buyLocks.add(mint);

    try {
      let keypair;
      try {
        keypair = requireWallet();
      } catch {
        await editTelegramMessage(
          chatId,
          messageId,
          `❌ Buy failed: no trading wallet configured. Set SOLANA_PRIVATE_KEY in Railway first.`,
          { replyMarkup: buyButtonMarkup(mint) }
        );
        return;
      }

      const pair = await fetchPairData(mint);
      const symbol = pair?.symbol ?? "???";
      const positionSizeSol = getSettings().positionSizeSol;

      const broker = new LiveBroker(keypair, WALLET_ID);
      let result;
      try {
        result = await broker.buy(mint, symbol, pair?.priceSol ?? 0, positionSizeSol);
      } catch (err) {
        await editTelegramMessage(chatId, messageId, `❌ Buy failed: ${err.message}`, {
          replyMarkup: buyButtonMarkup(mint),
        });
        return;
      }

      const entryPriceSol = result.amountSolSpent / result.amountTokens;
      this.openPositions.set(mint, {
        symbol,
        entryPriceSol,
        amountTokens: result.amountTokens,
        amountSolSpent: result.amountSolSpent,
        openedAt: Date.now(),
        chatId,
        messageId,
        lastShownPnlPct: 0,
      });

      logger.trade(`Manual BUY (Telegram): ${symbol} - ${result.amountSolSpent.toFixed(4)} SOL`);

      await editTelegramMessage(
        chatId,
        messageId,
        formatOpenPositionCard({
          symbol,
          mint,
          entryPriceSol,
          currentPriceSol: entryPriceSol,
          pnlPct: 0,
          amountSolSpent: result.amountSolSpent,
        }),
        { replyMarkup: sellButtonMarkup(mint) }
      );
    } finally {
      this.buyLocks.delete(mint);
    }
  }

  async handleSell(mint, chatId, messageId) {
    const position = this.openPositions.get(mint);
    if (!position) {
      // query.id was already answered by handleCallbackQuery before this ran
      // (Telegram only accepts one answer per callback) - editing the
      // message itself is the only way left to surface this to the user.
      await editTelegramMessage(chatId, messageId, `No open position found for this token - it may already be sold.`);
      return;
    }
    if (this.sellLocks.has(mint)) return;
    this.sellLocks.add(mint);

    try {
      const keypair = requireWallet();
      const broker = new LiveBroker(keypair, WALLET_ID);

      let result;
      try {
        result = await broker.sell(mint, position.symbol, position.entryPriceSol, position.amountTokens);
      } catch (err) {
        await editTelegramMessage(chatId, messageId, `❌ Sell failed: ${err.message}`, {
          replyMarkup: sellButtonMarkup(mint),
        });
        return;
      }

      const exitPriceSol = result.amountSolReceived / position.amountTokens;
      const pnlSol = result.amountSolReceived - position.amountSolSpent;
      const pnlPct = (result.amountSolReceived / position.amountSolSpent - 1) * 100;

      logger.trade(`Manual SELL (Telegram): ${position.symbol} - pnl ${pnlPct.toFixed(1)}% (${pnlSol.toFixed(4)} SOL)`);

      await editTelegramMessage(
        chatId,
        messageId,
        formatClosedPositionCard({
          symbol: position.symbol,
          mint,
          entryPriceSol: position.entryPriceSol,
          exitPriceSol,
          pnlPct,
          pnlSol,
          amountSolSpent: position.amountSolSpent,
        })
      );

      this.openPositions.delete(mint);
    } finally {
      this.sellLocks.delete(mint);
    }
  }

  async refreshOpenPositions() {
    for (const [mint, position] of this.openPositions) {
      const pair = await fetchPairData(mint);
      if (!pair || pair.priceSol <= 0) continue;

      const pnlPct = (pair.priceSol / position.entryPriceSol - 1) * 100;
      if (Math.abs(pnlPct - position.lastShownPnlPct) < PNL_EDIT_THRESHOLD_PCT) continue;

      position.lastShownPnlPct = pnlPct;
      position.lastPriceSol = pair.priceSol;
      await editTelegramMessage(
        position.chatId,
        position.messageId,
        formatOpenPositionCard({
          symbol: position.symbol,
          mint,
          entryPriceSol: position.entryPriceSol,
          currentPriceSol: pair.priceSol,
          pnlPct,
          amountSolSpent: position.amountSolSpent,
        }),
        { replyMarkup: sellButtonMarkup(mint) }
      );
    }
  }

  // For the dashboard's /api/status - never throws, degrades gracefully if
  // the wallet or RPC is unavailable.
  async getStatusSummary() {
    const wallet = loadWallet();
    let walletBalanceSol = null;
    if (wallet) {
      try {
        walletBalanceSol = (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
      } catch {
        // dashboard just shows "--" for balance, not fatal
      }
    }

    return {
      walletBalanceSol,
      openPositions: [...this.openPositions.entries()].map(([mint, p]) => ({
        mint,
        symbol: p.symbol,
        entryPriceSol: p.entryPriceSol,
        lastPriceSol: p.lastPriceSol ?? p.entryPriceSol,
        pnlPct: p.lastShownPnlPct,
        amountSolSpent: p.amountSolSpent,
        openedAt: p.openedAt,
      })),
      stats: store.getStats(WALLET_ID),
    };
  }
}

export const manualTrading = new ManualTradingController();
