import { config } from "../config.js";
import { getSettings } from "../settings.js";
import { logger } from "../notify/logger.js";
import { PumpFunSource } from "../sources/pumpfun.js";
import { fetchPairData } from "../sources/dexscreener.js";
import { isWatchlisted } from "../sources/watchlist.js";
import { runSafetyFilters } from "../safety/filters.js";
import { checkSellable } from "../safety/honeypot.js";
import { requireWallet } from "../wallet.js";
import { walletStore } from "../persistence/walletStore.js";
import { store } from "../persistence/store.js";
import { Position } from "./position.js";
import { PaperBroker } from "./paperBroker.js";
import { LiveBroker } from "./liveBroker.js";

const TICK_INTERVAL_MS = 5000;
const PRIMARY_ID = "primary";

function makeBroker(walletId, keypair) {
  return config.tradingMode === "live" ? new LiveBroker(keypair, walletId) : new PaperBroker(walletId);
}

// One trading account = one wallet's own broker + open positions. The
// primary account (from SOLANA_PRIVATE_KEY) always exists; additional
// accounts come from walletStore and can be added/removed/paused live from
// the dashboard, no redeploy needed.
class Account {
  constructor({ id, name, broker }) {
    this.id = id;
    this.name = name;
    this.broker = broker;
    this.openPositions = new Map();
  }

  isPaused() {
    if (this.id === PRIMARY_ID) return getSettings().tradingPaused;
    return walletStore.get(this.id)?.paused ?? true;
  }
}

export class TradingEngine {
  source = new PumpFunSource();
  accounts = [];
  pending = new Map();
  tickHandle = null;

  async start() {
    this.accounts = this.buildPrimaryAccount();
    this.syncAccounts();

    logger.info(`Starting in ${config.tradingMode.toUpperCase()} mode with ${this.accounts.length} wallet(s):`);
    for (const account of this.accounts) {
      try {
        const balance = await account.broker.getBalanceSol();
        logger.info(`  - ${account.name}: ${balance.toFixed(4)} SOL${account.isPaused() ? " (paused)" : ""}`);
      } catch (err) {
        // A boot-time RPC hiccup (rate limit, timeout) must never take the
        // whole bot down - this is just a startup log line, not a trading
        // decision. Balance gets checked again on every buy attempt anyway.
        logger.error(`  - ${account.name}: could not check balance at boot (${err.message})`);
      }
    }

    this.source.on("newToken", (event) => this.onNewToken(event));
    this.source.on("connected", () => logger.info("Connected to pump.fun new-token feed"));
    this.source.on("disconnected", () => logger.warn("Disconnected from pump.fun feed, reconnecting..."));
    this.source.on("error", (err) => logger.error(`pump.fun feed error: ${err.message}`));
    this.source.start();

    this.tickHandle = setInterval(() => {
      this.processCandidates().catch((err) => logger.error(`processCandidates failed: ${err}`));
      this.monitorPositions().catch((err) => logger.error(`monitorPositions failed: ${err}`));
    }, TICK_INTERVAL_MS);
  }

  stop() {
    this.source.stop();
    if (this.tickHandle) clearInterval(this.tickHandle);
  }

  buildPrimaryAccount() {
    const primaryName = getSettings().primaryWalletName || "Main";
    if (config.tradingMode === "live") {
      return [new Account({ id: PRIMARY_ID, name: primaryName, broker: makeBroker(PRIMARY_ID, requireWallet()) })];
    }
    return [new Account({ id: PRIMARY_ID, name: primaryName, broker: makeBroker(PRIMARY_ID, null) })];
  }

  // Picks up wallets added/removed from the dashboard without needing a
  // restart. Cheap enough to run every tick (walletStore is in-memory
  // cached after the first read).
  syncAccounts() {
    const desired = walletStore.listRaw();
    const desiredIds = new Set([PRIMARY_ID, ...desired.map((w) => w.id)]);

    const kept = this.accounts.filter((a) => desiredIds.has(a.id));
    if (kept.length !== this.accounts.length) {
      const removedNames = this.accounts.filter((a) => !desiredIds.has(a.id)).map((a) => a.name);
      logger.info(`Wallet(s) removed: ${removedNames.join(", ")}`);
    }
    this.accounts = kept;

    const currentIds = new Set(this.accounts.map((a) => a.id));
    for (const record of desired) {
      if (currentIds.has(record.id)) continue;
      const keypair = config.tradingMode === "live" ? walletStore.getKeypair(record.id) : null;
      this.accounts.push(new Account({ id: record.id, name: record.name, broker: makeBroker(record.id, keypair) }));
      logger.info(`Wallet account added: ${record.name}`);
    }
  }

  // Read by the dashboard API. Uses each position's last-known price (set
  // during monitorPositions ticks) instead of fetching fresh here, so
  // polling the dashboard never adds extra DexScreener/RPC load.
  async getStatus() {
    this.syncAccounts();

    const accounts = await Promise.all(
      this.accounts.map(async (account) => {
        let balanceSol = null;
        try {
          balanceSol = await account.broker.getBalanceSol();
        } catch (err) {
          logger.error(`Balance check failed for ${account.name}: ${err.message}`);
        }
        return {
          id: account.id,
          name: account.name,
          balanceSol,
          paused: account.isPaused(),
          stats: store.getStats(account.id),
          openPositions: [...account.openPositions.values()].map((p) => ({
            mint: p.mint,
            symbol: p.symbol,
            isWatchlisted: p.isWatchlisted,
            entryPriceSol: p.entryPriceSol,
            lastPriceSol: p.lastPriceSol,
            pnlPct: p.pnlPct(p.lastPriceSol),
            amountSolSpent: p.amountSolSpent,
            openedAt: p.openedAt,
          })),
        };
      })
    );

    return {
      mode: config.tradingMode,
      pendingCandidates: this.pending.size,
      familyStats: store.getStats(),
      accounts,
    };
  }

  hasOpenPositions(walletId) {
    const account = this.accounts.find((a) => a.id === walletId);
    return (account?.openPositions.size ?? 0) > 0;
  }

  onNewToken(event) {
    const alreadyOpen = this.accounts.some((a) => a.openPositions.has(event.mint));
    if (this.pending.has(event.mint) || alreadyOpen) return;
    this.pending.set(event.mint, { event });

    const watchlistTag = isWatchlisted(event.name, event.symbol) ? " [WATCHLIST]" : "";
    logger.info(`New token: ${event.symbol} (${event.name}) ${event.mint}${watchlistTag}`);
  }

  async processCandidates() {
    const now = Date.now();
    const settings = getSettings();

    for (const [mint, candidate] of this.pending) {
      const ageSec = (now - candidate.event.seenAt) / 1000;

      if (ageSec < settings.minTokenAgeSec) continue; // still waiting for the minimum age

      if (ageSec > settings.maxTokenAgeSec) {
        this.pending.delete(mint);
        const lastReason = candidate.lastReason ? ` (last reason: ${candidate.lastReason})` : "";
        logger.info(`Dropped ${candidate.event.symbol}: aged out of the buy window${lastReason}`);
        continue;
      }

      try {
        await this.evaluateCandidate(candidate, ageSec);
      } catch (err) {
        // One bad candidate (e.g. an RPC hiccup) shouldn't block every other
        // candidate waiting behind it in this same tick.
        logger.error(`Evaluating ${candidate.event.symbol} failed: ${err.message}`);
      }
    }
  }

  async evaluateCandidate(candidate, ageSec) {
    const { event } = candidate;

    this.syncAccounts();
    const activeAccounts = this.accounts.filter((a) => !a.isPaused());
    if (activeAccounts.length === 0) return; // nobody's trading right now, don't burn API quota

    const pair = await fetchPairData(event.mint);
    if (!pair) return; // not indexed by DexScreener yet, try again next tick

    const filterResult = await runSafetyFilters(event.mint, pair, ageSec);
    if (!filterResult.passed) {
      // Stays in `pending` and gets re-checked next tick, rather than being
      // thrown away after one look - liquidity and holder concentration in
      // particular change fast in a token's first few minutes (holder %
      // especially: the earliest buyer(s) naturally hold a large share right
      // after launch and it dilutes as more people buy in). Only aging out
      // of the window (handled by the caller) or a passing/disqualifying
      // result removes it for good.
      this.logRejectionIfChanged(candidate, filterResult.reasons.join("; "));
      return;
    }

    const decimals = filterResult.mintInfo?.decimals ?? 6;
    const honeypotCheck = await checkSellable(event.mint, decimals);
    if (!honeypotCheck.sellable) {
      this.logRejectionIfChanged(candidate, honeypotCheck.reason);
      return;
    }

    this.pending.delete(event.mint);

    for (const account of activeAccounts) {
      await this.buyForAccount(account, event, pair.priceSol);
    }
  }

  // Only logs when the reason actually changes, so a candidate sitting in
  // `pending` for 3 minutes doesn't spam an identical "Rejected" line every
  // 5-second tick.
  logRejectionIfChanged(candidate, reason) {
    if (candidate.lastReason === reason) return;
    candidate.lastReason = reason;
    logger.info(`Rejected ${candidate.event.symbol} (rechecking until it passes or ages out): ${reason}`);
  }

  async buyForAccount(account, event, priceSol) {
    const settings = getSettings();

    if (account.openPositions.has(event.mint)) return; // shouldn't happen, defensive

    if (account.openPositions.size >= settings.maxConcurrentPositions) {
      logger.info(`Skipping ${event.symbol} for ${account.name}: max concurrent positions reached`);
      return;
    }

    const watchlisted = isWatchlisted(event.name, event.symbol);
    const targetSize = settings.positionSizeSol * (watchlisted ? settings.watchlistPositionMultiplier : 1);

    let balance;
    try {
      balance = await account.broker.getBalanceSol();
    } catch (err) {
      logger.error(`Balance check failed for ${account.name}: ${err.message}`);
      return;
    }

    if (balance < targetSize * 0.5) {
      logger.warn(`Skipping ${event.symbol} for ${account.name}: balance too low (${balance.toFixed(4)} SOL)`);
      return;
    }
    const solAmount = Math.min(targetSize, balance);

    try {
      const result = await account.broker.buy(event.mint, event.symbol, priceSol, solAmount);
      const position = new Position({
        mint: event.mint,
        symbol: event.symbol,
        isWatchlisted: watchlisted,
        entryPriceSol: priceSol,
        amountTokens: result.amountTokens,
        amountSolSpent: result.amountSolSpent,
        openedAt: Date.now(),
      });
      account.openPositions.set(event.mint, position);
      logger.trade(
        `BOUGHT ${event.symbol} for ${account.name} - ${solAmount.toFixed(4)} SOL @ ${priceSol.toFixed(8)} SOL/token` +
          (watchlisted ? " (watchlisted - extended targets)" : "")
      );
    } catch (err) {
      logger.error(`Buy failed for ${event.symbol} (${account.name}): ${err}`);
    }
  }

  async monitorPositions() {
    const now = Date.now();
    const priceCache = new Map(); // avoid re-fetching the same mint for every account that holds it

    for (const account of this.accounts) {
      for (const [mint, position] of account.openPositions) {
        let pair = priceCache.get(mint);
        if (pair === undefined) {
          pair = await fetchPairData(mint);
          priceCache.set(mint, pair);
        }
        if (!pair) continue;

        const { shouldClose, reason } = position.evaluate(pair.priceSol, now);
        if (!shouldClose) continue;

        try {
          const result = await account.broker.sell(mint, position.symbol, pair.priceSol, position.amountTokens);
          const pnlPct = position.pnlPct(pair.priceSol);
          account.openPositions.delete(mint);
          logger.trade(
            `SOLD ${position.symbol} for ${account.name} - reason: ${reason}, pnl: ${pnlPct.toFixed(1)}%, ` +
              `received ${result.amountSolReceived.toFixed(4)} SOL`
          );
        } catch (err) {
          logger.error(`Sell failed for ${position.symbol} (${account.name}): ${err}`);
        }
      }
    }
  }
}
