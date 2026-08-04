import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "../config.js";

// Thin wrapper around PumpPortal's public new-token-creation feed
// (https://pumpportal.fun) - free, no API key, but best-effort/unofficial.
// Reconnects with backoff since this is the bot's primary discovery source.
export class PumpFunSource extends EventEmitter {
  ws = null;
  reconnectDelayMs = 2000;
  closedByUs = false;

  start() {
    this.closedByUs = false;
    this.connect();
  }

  stop() {
    this.closedByUs = true;
    this.ws?.close();
  }

  connect() {
    const ws = new WebSocket(config.sources.pumpfunWsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelayMs = 2000;
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      this.emit("connected");
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const event = this.normalize(msg);
        if (event) this.emit("newToken", event);
      } catch {
        // Ignore malformed / non-token messages (subscription acks, etc.)
      }
    });

    ws.on("close", () => {
      if (this.closedByUs) return;
      this.emit("disconnected");
      setTimeout(() => this.connect(), this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    });

    ws.on("error", (err) => {
      this.emit("error", err);
    });
  }

  normalize(msg) {
    if (!msg || msg.txType !== "create" || !msg.mint) return null;
    return {
      mint: msg.mint,
      name: msg.name ?? "unknown",
      symbol: msg.symbol ?? "???",
      creator: msg.traderPublicKey ?? "unknown",
      seenAt: Date.now(),
      initialLiquiditySol: Number(msg.vSolInBondingCurve ?? 0),
      marketCapSol: Number(msg.marketCapSol ?? 0),
    };
  }
}
