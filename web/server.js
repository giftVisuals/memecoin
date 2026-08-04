import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "../config.js";
import { logger } from "../notify/logger.js";
import { store } from "../persistence/store.js";
import { getSettings, updateSettings } from "../settings.js";
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
    const stats = store.getStats();
    res.json({ ...status, stats });
  });

  app.get("/api/trades", (req, res) => {
    const trades = [...store.getTrades()].sort(
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

  const server = app.listen(config.port, () => {
    logger.info(`Dashboard listening on port ${config.port}`);
  });

  return server;
}
