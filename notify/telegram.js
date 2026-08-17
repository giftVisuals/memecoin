import { config } from "../config.js";
import { logger } from "./logger.js";

export const telegramEnabled = Boolean(config.telegram.botToken && config.telegram.chatId);

const API_BASE = () => `https://api.telegram.org/bot${config.telegram.botToken}`;

// Never throws - a Telegram outage or bad token should never take the signal
// engine down. Worst case, an alert is missed and logged; the next candidate
// still gets evaluated normally. Returns the sent message's ID (needed to
// edit it later for Buy Now/Sell Now/live PnL) alongside success.
export async function sendTelegramMessage(html, { replyMarkup } = {}) {
  if (!telegramEnabled) {
    logger.warn("Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) - alert not sent.");
    return { ok: false, messageId: null };
  }

  try {
    const res = await fetch(`${API_BASE()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      logger.error(`Telegram send failed (${res.status}): ${JSON.stringify(body)}`);
      return { ok: false, messageId: null };
    }
    return { ok: true, messageId: body.result?.message_id ?? null };
  } catch (err) {
    logger.error(`Telegram send failed: ${err.message}`);
    return { ok: false, messageId: null };
  }
}

// Used to update an already-sent alert in place (Buy Now -> "bought, +12%"
// -> "sold, final +34%") instead of spamming a new message per price tick.
export async function editTelegramMessage(chatId, messageId, html, { replyMarkup } = {}) {
  if (!telegramEnabled) return false;
  try {
    const res = await fetch(`${API_BASE()}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: replyMarkup ?? { inline_keyboard: [] },
      }),
    });
    const body = await res.json().catch(() => ({}));
    // "message is not modified" isn't a real failure - just means the PnL
    // rounded to the same value as last edit, nothing to do.
    if (!res.ok && !String(body.description ?? "").includes("not modified")) {
      logger.error(`Telegram edit failed (${res.status}): ${JSON.stringify(body)}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.error(`Telegram edit failed: ${err.message}`);
    return false;
  }
}

// Every button tap MUST be acknowledged or Telegram shows the user a
// "loading forever" spinner on that button. showAlert=true pops a modal
// (used for errors); false shows a quick toast.
export async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
  if (!telegramEnabled) return;
  try {
    await fetch(`${API_BASE()}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: showAlert }),
    });
  } catch (err) {
    logger.error(`Telegram answerCallbackQuery failed: ${err.message}`);
  }
}

// Long-polling read of incoming updates (button taps, messages). No webhook
// needed - simpler to run reliably on Railway without a stable public URL
// requirement. offset excludes everything already seen; timeoutSec is how
// long Telegram holds the connection open waiting for something to happen.
export async function getTelegramUpdates(offset, timeoutSec = 25) {
  if (!telegramEnabled) return [];
  const url = new URL(`${API_BASE()}/getUpdates`);
  url.searchParams.set("timeout", String(timeoutSec));
  url.searchParams.set("allowed_updates", JSON.stringify(["callback_query"]));
  if (offset !== undefined) url.searchParams.set("offset", String(offset));

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout((timeoutSec + 10) * 1000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(`getUpdates failed (${res.status}): ${JSON.stringify(body)}`);
  return body.result ?? [];
}
