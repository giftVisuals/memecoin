import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "../config.js";
import { logger } from "../notify/logger.js";

// Separate connection from sources/pumpfun.js on purpose: that one is the
// free, anonymous subscribeNewToken feed; this one authenticates with a
// PumpPortal API key because subscribeAccountTrade is metered per event
// (0.01 SOL / 10,000 events, billed against the wallet linked to the key).
// Mixing them onto one socket would mean an API-key requirement for a
// feature (new-token alerts) that's supposed to stay free.
export class PumpFunAccountTradeSource extends EventEmitter {
  ws = null;
  reconnectDelayMs = 2000;
  closedByUs = false;
  subscribedAddresses = new Set();

  start(addresses) {
    this.closedByUs = false;
    this.subscribedAddresses = new Set(addresses);
    this.connect();
  }

  stop() {
    this.closedByUs = true;
    this.ws?.close();
  }

  // Called whenever the dashboard-edited wallet list changes. PumpPortal's
  // docs don't document an unsubscribe method, so the simplest correct thing
  // is a full reconnect with the current full list rather than trying to
  // incrementally (un)subscribe - this only runs when a human edits the
  // list, so it's rare, not a hot path.
  updateAddresses(addresses) {
    const next = new Set(addresses);
    const same = next.size === this.subscribedAddresses.size && [...next].every((a) => this.subscribedAddresses.has(a));
    if (same) return;
    this.subscribedAddresses = next;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(); // triggers reconnect with the new list via the close handler
    }
  }

  connect() {
    if (this.subscribedAddresses.size === 0) return; // nothing to watch, don't open a socket for no reason

    const url = `wss://pumpportal.fun/api/data?api-key=${config.pumpportal.apiKey}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelayMs = 2000;
      ws.send(JSON.stringify({ method: "subscribeAccountTrade", keys: [...this.subscribedAddresses] }));
      this.emit("connected");
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const event = this.normalize(msg);
        if (event) this.emit("walletTrade", event);
      } catch {
        // Ignore malformed / non-trade messages (subscription acks, etc.)
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
    if (!msg || !msg.mint || !msg.traderPublicKey) return null;
    if (msg.txType !== "buy" && msg.txType !== "sell") return null;
    return {
      mint: msg.mint,
      trader: msg.traderPublicKey,
      side: msg.txType,
      solAmount: Number(msg.solAmount ?? 0),
      tokenAmount: Number(msg.tokenAmount ?? 0),
      marketCapSol: Number(msg.marketCapSol ?? 0),
      seenAt: Date.now(),
    };
  }
}
