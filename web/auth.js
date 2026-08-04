import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../notify/logger.js";

const USERNAME = "g4";

function generatePassword() {
  return crypto.randomBytes(9).toString("base64url");
}

const password = config.dashboardPassword || generatePassword();
if (!config.dashboardPassword) {
  logger.warn(
    `No DASHBOARD_PASSWORD set - generated one for this run only: "${password}" (login as "${USERNAME}"). ` +
      "Set DASHBOARD_PASSWORD in Railway so this doesn't change every restart."
  );
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Everything the dashboard exposes - PnL, settings, the ability to change
// position sizing - so it's gated behind a shared password by default,
// even before any real money is involved.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
    const sepIndex = decoded.indexOf(":");
    const user = decoded.slice(0, sepIndex);
    const pass = decoded.slice(sepIndex + 1);
    if (timingSafeStringEqual(user, USERNAME) && timingSafeStringEqual(pass, password)) {
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="G4 Scraper"');
  res.status(401).send("Authentication required");
}
