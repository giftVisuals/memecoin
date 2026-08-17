import { config } from "../config.js";
import { logger } from "./logger.js";

export const telegramEnabled = Boolean(config.telegram.botToken && config.telegram.chatId);

// Never throws - a Telegram outage or bad token should never take the signal
// engine down. Worst case, an alert is missed and logged; the next candidate
// still gets evaluated normally.
export async function sendTelegramMessage(html) {
  if (!telegramEnabled) {
    logger.warn("Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) - alert not sent.");
    return false;
  }

  const url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error(`Telegram send failed (${res.status}): ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.error(`Telegram send failed: ${err.message}`);
    return false;
  }
}
