function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  info(msg: string): void {
    console.log(`[${timestamp()}] ${msg}`);
  },
  warn(msg: string): void {
    console.warn(`[${timestamp()}] WARN: ${msg}`);
  },
  error(msg: string): void {
    console.error(`[${timestamp()}] ERROR: ${msg}`);
  },
  trade(msg: string): void {
    console.log(`[${timestamp()}] TRADE: ${msg}`);
  },
};
