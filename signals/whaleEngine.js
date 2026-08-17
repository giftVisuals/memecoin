import { config } from "../config.js";
import { getSettings, parseSmartWallets } from "../settings.js";
import { logger } from "../notify/logger.js";
import { PumpFunAccountTradeSource } from "../sources/pumpfunAccountTrades.js";
import { fetchPairData } from "../sources/dexscreener.js";
import { getSolUsdPrice } from "../sources/solPrice.js";
import { getMintInfo } from "../solanaConnection.js";
import { getTopHolderStats, getHolderCount } from "./holders.js";
import { checkSellable } from "../safety/honeypot.js";
import { scoreCandidate } from "./scorer.js";
import { formatWhaleBuyAlert } from "./format.js";
import { sendTelegramMessage } from "../notify/telegram.js";
import { buyButtonMarkup } from "./manualTrading.js";

const WALLET_LIST_REFRESH_MS = 30_000;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000; // don't re-alert the same wallet buying the same mint again within this

// Watches a dashboard-curated list of wallets (settings.smartWallets) via
// PumpPortal's metered subscribeAccountTrade feed, and sends a Telegram
// alert whenever one of them buys something. Entirely inert (no socket
// opened, no cost incurred) until both PUMPPORTAL_API_KEY is set and the
// list has at least one address in it.
export class WhaleEngine {
  source = new PumpFunAccountTradeSource();
  recentAlerts = new Map(); // "wallet:mint" -> last alerted timestamp
  refreshHandle = null;
  warnedNoApiKey = false;

  async start() {
    if (!config.pumpportal.apiKey) {
      logger.info(
        "Smart wallet watching not configured (PUMPPORTAL_API_KEY unset) - skipping. " +
          "Add wallets in Settings and set the key to turn this on."
      );
      return;
    }

    this.source.on("connected", () => logger.info("Connected to PumpPortal wallet-trade feed"));
    this.source.on("disconnected", () => logger.warn("Disconnected from wallet-trade feed, reconnecting..."));
    this.source.on("error", (err) => logger.error(`Wallet-trade feed error: ${err.message}`));
    this.source.on("walletTrade", (event) => {
      if (event.side === "buy") this.onWalletBuy(event).catch((err) => logger.error(`Whale alert failed: ${err}`));
    });

    const addresses = this.currentAddresses();
    if (addresses.length > 0) {
      logger.info(`Watching ${addresses.length} smart wallet(s) for buys.`);
      this.source.start(addresses);
    } else {
      logger.info("Smart wallet watching configured but the list is empty - add some in Settings.");
    }

    this.refreshHandle = setInterval(() => this.refreshWalletList(), WALLET_LIST_REFRESH_MS);
  }

  stop() {
    this.source.stop();
    if (this.refreshHandle) clearInterval(this.refreshHandle);
  }

  currentAddresses() {
    return parseSmartWallets(getSettings().smartWallets).map((w) => w.address);
  }

  refreshWalletList() {
    if (!config.pumpportal.apiKey) return;
    const addresses = this.currentAddresses();
    if (addresses.length === 0) return;
    if (!this.source.ws) {
      logger.info(`Watching ${addresses.length} smart wallet(s) for buys.`);
      this.source.start(addresses);
    } else {
      this.source.updateAddresses(addresses);
    }
  }

  async onWalletBuy(event) {
    const key = `${event.trader}:${event.mint}`;
    const last = this.recentAlerts.get(key);
    if (last && Date.now() - last < DEDUPE_WINDOW_MS) return;
    this.recentAlerts.set(key, Date.now());

    const wallets = parseSmartWallets(getSettings().smartWallets);
    const tracked = wallets.find((w) => w.address === event.trader);
    if (!tracked) return; // list changed since this trade was queued up

    const mintInfo = await getMintInfo(event.mint);
    if (!mintInfo) return; // can't score it, skip rather than send a half-blank alert

    const [topHolderStats, pair, holderCount, honeypotCheck] = await Promise.all([
      getTopHolderStats(event.mint, mintInfo.supply),
      fetchPairData(event.mint),
      getHolderCount(event.mint),
      checkSellable(event.mint, mintInfo.decimals),
    ]);

    const liquiditySol = pair?.liquiditySol > 0 ? pair.liquiditySol : 0;
    const score = scoreCandidate({
      mintInfo,
      top1Pct: topHolderStats.top1Pct,
      top10Pct: topHolderStats.top10Pct,
      holderCount,
      liquiditySol,
      sellable: honeypotCheck.sellable,
    });

    const solUsd = await getSolUsdPrice();
    const marketCapUsd = pair?.fdvUsd > 0 ? pair.fdvUsd : event.marketCapSol * solUsd;

    const html = formatWhaleBuyAlert({
      walletLabel: tracked.label,
      walletAddress: event.trader,
      mint: event.mint,
      name: pair?.name ?? "unknown",
      symbol: pair?.symbol ?? "???",
      liquidityUsd: pair?.liquidityUsd ?? 0,
      marketCapUsd,
      holderCount,
      top10Pct: topHolderStats.top10Pct,
      score,
      solSpent: event.solAmount,
    });

    const { ok } = await sendTelegramMessage(html, { replyMarkup: buyButtonMarkup(event.mint) });
    if (ok) {
      logger.info(`Whale alert: ${tracked.label} bought ${event.mint} (${event.solAmount.toFixed(3)} SOL)`);
    }
  }
}
