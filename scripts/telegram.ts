import fs from "fs";
import path from "path";

/**
 * MISOGYNY.EXE V6 — Telegram bot helpers
 *
 * Minimal wrapper over the Telegram Bot API used for the mint-approval flow.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN          — bot token from @BotFather
 *   TELEGRAM_OPERATOR_CHAT_ID   — numeric chat ID of the operator (get via /start + getUpdates)
 *
 * See V6 spec §8.1 for the approval flow and message format.
 */

const API = "https://api.telegram.org";
const POLL_STATE_PATH = path.join(__dirname, "..", "data", "telegram-poll-state.json");

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TgSendOptions {
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  disableWebPagePreview?: boolean;
  replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] };
}

export function isConfigured(): boolean {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_OPERATOR_CHAT_ID);
}

function requireConfig(): { token: string; chatId: string } {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_OPERATOR_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_OPERATOR_CHAT_ID must be set in .env");
  }
  return { token, chatId };
}

export async function sendMessage(text: string, opts: TgSendOptions = {}): Promise<number> {
  const { token, chatId } = requireConfig();
  const body: any = {
    chat_id: chatId,
    text,
    disable_web_page_preview: opts.disableWebPagePreview ?? true,
  };
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;

  const res = await fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed (${res.status}): ${err.slice(0, 200)}`);
  }
  const data = (await res.json()) as { ok: boolean; result: { message_id: number } };
  return data.result.message_id;
}

export async function editMessageText(
  messageId: number,
  text: string,
  opts: TgSendOptions = {}
): Promise<void> {
  const { token, chatId } = requireConfig();
  const body: any = {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: opts.disableWebPagePreview ?? true,
  };
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;

  const res = await fetch(`${API}/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Telegram editMessageText failed (${res.status}): ${err.slice(0, 200)}`);
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  const { token } = requireConfig();
  const body: any = { callback_query_id: callbackQueryId };
  if (text) body.text = text;
  await fetch(`${API}/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
}

export interface CallbackUpdate {
  updateId: number;
  callbackQueryId: string;
  data: string;
  messageId: number;
}

/** Poll for callback updates (button presses). Returns only new updates since the last poll. */
export async function pollCallbacks(): Promise<CallbackUpdate[]> {
  const { token } = requireConfig();
  const lastOffset = loadPollOffset();

  const res = await fetch(
    `${API}/bot${token}/getUpdates?timeout=0&allowed_updates=%5B%22callback_query%22%5D${lastOffset ? `&offset=${lastOffset + 1}` : ""}`,
    { signal: AbortSignal.timeout(30_000) }
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    ok: boolean;
    result: Array<{
      update_id: number;
      callback_query?: {
        id: string;
        data: string;
        message?: { message_id: number };
      };
    }>;
  };

  const updates: CallbackUpdate[] = [];
  let maxId = lastOffset;
  for (const u of data.result) {
    if (u.update_id > maxId) maxId = u.update_id;
    if (!u.callback_query) continue;
    const cb = u.callback_query;
    if (!cb.message) continue;
    updates.push({
      updateId: u.update_id,
      callbackQueryId: cb.id,
      data: cb.data,
      messageId: cb.message.message_id,
    });
  }

  if (maxId !== lastOffset) savePollOffset(maxId);
  return updates;
}

function loadPollOffset(): number {
  if (!fs.existsSync(POLL_STATE_PATH)) return 0;
  try {
    return JSON.parse(fs.readFileSync(POLL_STATE_PATH, "utf-8")).offset || 0;
  } catch {
    return 0;
  }
}

function savePollOffset(offset: number): void {
  const dir = path.dirname(POLL_STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(POLL_STATE_PATH, JSON.stringify({ offset }));
}

/** Escape text for Telegram Markdown (MarkdownV2 is strict — we use plain). Basic safety. */
export function sanitize(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
}
