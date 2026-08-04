function timestamp() {
  return new Date().toISOString();
}

export const logger = {
  info(msg) {
    console.log(`[${timestamp()}] ${msg}`);
  },
  warn(msg) {
    console.warn(`[${timestamp()}] WARN: ${msg}`);
  },
  error(msg) {
    console.error(`[${timestamp()}] ERROR: ${msg}`);
  },
  trade(msg) {
    console.log(`[${timestamp()}] TRADE: ${msg}`);
  },
};
