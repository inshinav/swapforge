// Исходящий Telegram Bot API (SPEC §6): доставка каруселей и уведомления. Greenfield —
// прежде токен использовался только для проверки подписи Login Widget. Fail-tolerant:
// доставка вторична, ошибки не роняют вызвавший поток.
// ВАЖНО: слайды лежат за auth — Telegram не сходит по нашим URL, поэтому байты
// аплоадятся multipart-ом (attach://) прямо из файлов.
import fs from 'node:fs';
import { config } from '../config';

export interface TgSendDeps {
  fetchImpl?: typeof fetch;
}

type TgResult = { ok: true } | { ok: false; needStart: boolean; error: string };

async function tgJson(
  method: string,
  payload: Record<string, unknown>,
  deps: TgSendDeps = {},
): Promise<{ ok: boolean; status: number; body: string }> {
  const doFetch = deps.fetchImpl ?? fetch;
  if (!config.telegramBotToken) return { ok: false, status: 0, body: 'нет TELEGRAM_BOT_TOKEN' };
  try {
    const res = await doFetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    return { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, body: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

async function tgMultipart(
  method: string,
  form: FormData,
  deps: TgSendDeps = {},
): Promise<{ ok: boolean; status: number; body: string }> {
  const doFetch = deps.fetchImpl ?? fetch;
  if (!config.telegramBotToken) return { ok: false, status: 0, body: 'нет TELEGRAM_BOT_TOKEN' };
  try {
    const res = await doFetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    return { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, body: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/** Прекол: может ли бот писать юзеру (403 = юзер не нажал Start). */
export async function canMessageUser(telegramId: number, deps: TgSendDeps = {}): Promise<boolean> {
  const res = await tgJson('sendChatAction', { chat_id: telegramId, action: 'upload_photo' }, deps);
  return res.ok;
}

function fileBlob(filePath: string): Blob {
  return new Blob([fs.readFileSync(filePath)], { type: 'image/jpeg' });
}

/**
 * Отправить карусель альбомом из локальных файлов: sendMediaGroup требует 2–10 медиа,
 * при одном — фолбэк sendPhoto; подпись отдельным сообщением.
 */
export async function sendCarouselToTelegram(
  input: { telegramId: number; filePaths: string[]; caption: string | null },
  deps: TgSendDeps = {},
): Promise<TgResult> {
  const files = input.filePaths.filter((p) => fs.existsSync(p)).slice(0, 10);
  if (files.length === 0) return { ok: false, needStart: false, error: 'нет готовых слайдов' };
  if (!(await canMessageUser(input.telegramId, deps))) {
    return { ok: false, needStart: true, error: 'бот не может написать первым' };
  }
  let sent: { ok: boolean; status: number; body: string };
  if (files.length === 1) {
    const form = new FormData();
    form.set('chat_id', String(input.telegramId));
    form.set('photo', fileBlob(files[0]!), 'slide-01.jpg');
    sent = await tgMultipart('sendPhoto', form, deps);
  } else {
    const form = new FormData();
    form.set('chat_id', String(input.telegramId));
    form.set(
      'media',
      JSON.stringify(files.map((_, i) => ({ type: 'photo', media: `attach://slide${i}` }))),
    );
    files.forEach((p, i) => form.set(`slide${i}`, fileBlob(p), `slide-${String(i + 1).padStart(2, '0')}.jpg`));
    sent = await tgMultipart('sendMediaGroup', form, deps);
  }
  if (!sent.ok) return { ok: false, needStart: sent.status === 403, error: sent.body };
  if (input.caption) {
    await tgJson('sendMessage', { chat_id: input.telegramId, text: input.caption.slice(0, 4000) }, deps);
  }
  return { ok: true };
}

/** Уведомление о готовности (best-effort, тихо молчит при 403/сбоях). */
export async function notifyCarouselReady(
  input: { telegramId: number; title: string; slides: number },
  deps: TgSendDeps = {},
): Promise<void> {
  await tgJson(
    'sendMessage',
    {
      chat_id: input.telegramId,
      text: `Карусель «${input.title}» готова: ${input.slides} слайдов. Забери в SwapForge → Карусели.`,
    },
    deps,
  );
}
