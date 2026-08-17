import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { logger } from "../notify/logger.js";
import { store } from "../persistence/store.js";
import { getSettings, updateSettings } from "../settings.js";
import { loadWallet, generateNewWallet } from "../wallet.js";
import { walletStore } from "../persistence/walletStore.js";
import { connection } from "../solanaConnection.js";
import { LAMPORTS_PER_SOL } from "../constants.js";
import { manualTrading } from "../signals/manualTrading.js";
import { sendTelegramMessage, telegramEnabled } from "../notify/telegram.js";
import { formatNewTokenAlert } from "../signals/format.js";
import { scoreCandidate } from "../signals/scorer.js";
import { requireAuth } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

export function startDashboardServer(engine) {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (req, res) => res.status(200).send("ok"));

  app.use(requireAuth);
  app.use(express.static(publicDir));

  app.get("/api/status", async (req, res) => {
    const status = await engine.getStatus();
    if (config.tradingMode === "signal") {
      status.manualTrading = await manualTrading.getStatusSummary();
    }
    res.json(status);
  });

  app.get("/api/trades", (req, res) => {
    const trades = [...store.getTrades(req.query.walletId || undefined)].sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    );
    res.json(trades.slice(0, 100));
  });

  // Sends a made-up alert with realistic numbers so you can see the exact
  // format Telegram alerts use without waiting for a real token to trigger
  // one. Deliberately has no Buy Now button - the mint is fake, so a real
  // buy attempt against it would just fail confusingly, or worse, encourage
  // tapping "buy" on something that was never a real signal.
  app.post("/api/test-alert", async (req, res) => {
    if (!telegramEnabled) {
      res.status(400).json({ error: "Telegram not configured yet - set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID first." });
      return;
    }

    const score = scoreCandidate({
      mintInfo: { mintAuthorityRenounced: true, freezeAuthorityRenounced: true, supply: 1_000_000_000, decimals: 6 },
      top1Pct: 12.4,
      top10Pct: 27.4,
      holderCount: 341,
      liquiditySol: 300,
      sellable: true,
    });
    const mint = "TestMint1111111111111111111111111111111111";
    const html =
      `🧪 <b>TEST MESSAGE</b> - this is what a real alert looks like. Not a real signal, no Buy Now button on purpose.\n\n` +
      formatNewTokenAlert({
        event: { name: "Example Doge Meme", symbol: "EDOGE", mint },
        mint,
        liquidityUsd: 48200,
        marketCapUsd: 612000,
        holderCount: 341,
        top10Pct: 27.4,
        score,
      });

    const { ok } = await sendTelegramMessage(html);
    if (!ok) {
      res.status(502).json({ error: "Telegram rejected the message - double check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID." });
      return;
    }
    res.json({ ok: true });
  });

  app.get("/api/settings", (req, res) => {
    res.json(getSettings());
  });

  app.put("/api/settings", async (req, res) => {
    try {
      const updated = await updateSettings(req.body ?? {});
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // The primary wallet (SOLANA_PRIVATE_KEY) matters in every mode now -
  // signal mode's Buy Now button spends from it too - so these two stay
  // registered regardless of tradingMode.
  app.get("/api/wallet", async (req, res) => {
    const wallet = loadWallet();
    if (!wallet) {
      res.json({ hasWallet: false });
      return;
    }
    try {
      const lamports = await connection.getBalance(wallet.publicKey);
      res.json({
        hasWallet: true,
        address: wallet.publicKey.toBase58(),
        balanceSol: lamports / LAMPORTS_PER_SOL,
      });
    } catch (err) {
      res.json({ hasWallet: true, address: wallet.publicKey.toBase58(), balanceSol: null, error: err.message });
    }
  });

  // Generates a keypair and returns the secret key exactly once - nothing
  // is written to disk or logged. The user must copy it and set it as
  // SOLANA_PRIVATE_KEY in Railway themselves; this endpoint can't do that
  // part for them, since it doesn't have access to Railway's variables.
  app.post("/api/wallet/generate", (req, res) => {
    res.json(generateNewWallet());
  });

  // Multiple managed wallets (one per family member, auto-traded together)
  // only makes sense in paper/live mode - signal mode has exactly one
  // wallet (the primary one, above) and no auto-trading to assign it to.
  if (config.tradingMode !== "signal") {
    // Additional (managed) wallets beyond the primary one - each entry here
    // has its private key encrypted at rest and is fully driven by the
    // dashboard, no Railway variables involved.
    app.get("/api/wallets", async (req, res) => {
      const wallets = walletStore.list();
      const withBalances = await Promise.all(
        wallets.map(async (w) => {
          try {
            const lamports = await connection.getBalance(new PublicKey(w.address));
            return { ...w, balanceSol: lamports / LAMPORTS_PER_SOL };
          } catch (err) {
            return { ...w, balanceSol: null, error: err.message };
          }
        })
      );
      res.json(withBalances);
    });

    app.post("/api/wallets", async (req, res) => {
      try {
        const created = await walletStore.addWallet(req.body?.name);
        res.json(created);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    app.put("/api/wallets/:id", async (req, res) => {
      try {
        let wallet;
        if (req.body?.paused !== undefined) wallet = await walletStore.setPaused(req.params.id, req.body.paused);
        if (req.body?.name !== undefined) wallet = await walletStore.setName(req.params.id, req.body.name);
        if (!wallet) return res.status(400).json({ error: "Nothing to update" });
        const { encryptedSecretKey, ...safe } = wallet;
        res.json(safe);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    app.delete("/api/wallets/:id", async (req, res) => {
      if (engine.hasOpenPositions(req.params.id)) {
        res.status(400).json({ error: "Can't remove a wallet with open positions - wait for them to close first." });
        return;
      }
      try {
        await walletStore.removeWallet(req.params.id);
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });
  }

  const server = app.listen(config.port, () => {
    logger.info(`Dashboard listening on port ${config.port}`);
  });

  return server;
}
