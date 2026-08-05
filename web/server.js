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
    res.json(await engine.getStatus());
  });

  app.get("/api/trades", (req, res) => {
    const trades = [...store.getTrades(req.query.walletId || undefined)].sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    );
    res.json(trades.slice(0, 100));
  });

  app.get("/api/settings", (req, res) => {
    res.json(getSettings());
  });

  app.put("/api/settings", (req, res) => {
    try {
      const updated = updateSettings(req.body ?? {});
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

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

  // Generates a keypair and returns the secret key exactly once - nothing is
  // written to disk or logged. The user must copy it and set it as
  // SOLANA_PRIVATE_KEY in Railway themselves; this endpoint can't do that
  // part for them, since it doesn't have access to Railway's variables.
  app.post("/api/wallet/generate", (req, res) => {
    res.json(generateNewWallet());
  });

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

  app.post("/api/wallets", (req, res) => {
    try {
      const created = walletStore.addWallet(req.body?.name);
      res.json(created);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put("/api/wallets/:id", (req, res) => {
    try {
      let wallet;
      if (req.body?.paused !== undefined) wallet = walletStore.setPaused(req.params.id, req.body.paused);
      if (req.body?.name !== undefined) wallet = walletStore.setName(req.params.id, req.body.name);
      if (!wallet) return res.status(400).json({ error: "Nothing to update" });
      const { encryptedSecretKey, ...safe } = wallet;
      res.json(safe);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/wallets/:id", (req, res) => {
    if (engine.hasOpenPositions(req.params.id)) {
      res.status(400).json({ error: "Can't remove a wallet with open positions - wait for them to close first." });
      return;
    }
    try {
      walletStore.removeWallet(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  const server = app.listen(config.port, () => {
    logger.info(`Dashboard listening on port ${config.port}`);
  });

  return server;
}
