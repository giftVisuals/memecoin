import { getSettings, parseSmartWallets } from "../settings.js";
import { logger } from "../notify/logger.js";
import { WalletTradeWatcher } from "../sources/walletTradeWatcher.js";
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

// Watches a dashboard-curated list of wallets (settings.smartWallets) and
// sends a Telegram alert whenever one of them buys something. Free - runs
// on the same Helius RPC connection as everything else, no separate wallet
// or API key needed. Entirely inert until the list has at least one address
// in it.
export class WhaleEngine {
  source = new WalletTradeWatcher();
  recentAlerts = new Map(); // "wallet:mint" -> last alerted timestamp
  refreshHandle = null;

  async start() {
    this.source.on("walletTrade", (event) => {
      if (event.side === "buy") this.onWalletBuy(event).catch((err) => logger.error(`Whale alert failed: ${err}`));
    });

    const addresses = this.currentAddresses();
    if (addresses.length > 0) {
      logger.info(`Watching ${addresses.length} smart wallet(s) for buys.`);
      this.source.start(addresses);
    } else {
      logger.info("Smart wallet watching: list is empty - add wallets in Settings to turn this on.");
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
    const addresses = this.currentAddresses();
    this.source.updateAddresses(addresses); // no-ops internally if unchanged
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
    const marketCapUsd = pair?.fdvUsd ?? 0;

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
