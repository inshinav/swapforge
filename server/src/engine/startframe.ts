// Генерация стартового кадра по Images API (OpenAI gpt-image-*): imagePrompt + реф-фото →
// готовый кадр в максимальном качестве. Это reference image 1 для Seedance.
import OpenAI, { toFile } from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { framesDir, refsDir, startDir } from '../storage';
import { recordUsage } from '../usage';
import { FIGURE_TIER1, FIGURE_TIER2 } from './doctrine';
import type { RefInfo, VideoMeta } from '../../../shared/api-types';

export { startDir } from '../storage';

/** Модерационный отказ Images API — сигнал к детерминированному смягчению фразы фигуры. */
export function isModerationRefusal(msg: string): boolean {
  return /safety|moderation|content.?policy|policy violation|rejected|not allowed|invalid_prompt/i.test(msg);
}

/**
 * Двухъярусное смягчение: tier1 → tier2 → без фразы вовсе (свап-промт фразу сохраняет —
 * модерация Seedance отдельная). Возвращает цепочку промтов на попытки.
 */
export function moderationLadder(prompt: string): string[] {
  const ladder = [prompt];
  if (prompt.includes(FIGURE_TIER1)) {
    ladder.push(prompt.replace(FIGURE_TIER1, FIGURE_TIER2));
    ladder.push(prompt.replace(FIGURE_TIER1, '').replace(/ {2,}/g, ' ').trim());
  } else if (prompt.includes(FIGURE_TIER2)) {
    ladder.push(prompt.replace(FIGURE_TIER2, '').replace(/ {2,}/g, ' ').trim());
  }
  return ladder;
}

/** Гибкие размеры (кратно 16) поддерживает только gpt-image-2; у остальных — фиксированная тройка. */
export function imageModelFlexible(id: string): boolean {
  return id === 'gpt-image-2';
}

/**
 * Размер под AR исходника. gpt-image-2 принимает любые размеры кратно 16 (длинная сторона = target);
 * gpt-image-1/1.5/mini — только фиксированную тройку 1024x1024 / 1024x1536 / 1536x1024.
 */
export function startFrameSize(
  width: number,
  height: number,
  model: string,
  longSide = config.imageLongSide,
): string {
  const ar = width && height ? width / height : 9 / 16;
  if (!imageModelFlexible(model)) {
    if (ar < 0.95) return '1024x1536';
    if (ar > 1.05) return '1536x1024';
    return '1024x1024';
  }
  const snap = (v: number) => Math.max(256, Math.round(v / 16) * 16);
  if (ar <= 1) return `${snap(longSide * ar)}x${snap(longSide)}`;
  return `${snap(longSide)}x${snap(longSide / ar)}`;
}

interface ImagesResponse {
  data?: Array<{ b64_json?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface StartFrameOpts {
  /** Кадр строго 9:16 (авто-флоу: выход рендера фиксирован 9:16 независимо от AR исходника). */
  forceNineSixteen?: boolean;
  /** Тестовая инъекция вызова Images API. */
  _editFn?: (params: Record<string, unknown>) => Promise<ImagesResponse>;
}

export async function generateStartFrame(
  projectId: string,
  version: number,
  imagePrompt: string,
  refs: RefInfo[],
  meta: VideoMeta,
  opts: StartFrameOpts = {},
): Promise<string> {
  if (!config.openaiApiKey) {
    throw new Error('Для генерации стартового кадра нужен OpenAI-ключ (Images API)');
  }
  // Кадры всегда на последней модели в максимальном качестве — решение Alex
  const model = config.openaiImageModel;
  const quality = config.imageQuality;
  const client = new OpenAI({ apiKey: config.openaiApiKey, maxRetries: 2, timeout: 300_000 });

  const MIME: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  };
  const images = await Promise.all(
    refs.map((r) =>
      toFile(fs.createReadStream(path.join(refsDir(projectId), r.file)), r.file, {
        type: MIME[path.extname(r.file).toLowerCase()] ?? 'image/jpeg',
      }),
    ),
  );
  if (images.length === 0) throw new Error('Нет референсов — приложи фото модели');
  // Первый кадр исходника — ПЕРВЫМ изображением: кадр = in-place edit (фон/ракурс/свет
  // остаются пиксель-в-пиксель), а не реконструкция по описанию (та уводила композицию)
  const firstFrame = path.join(framesDir(projectId), 'first.jpg');
  const hasSourceFrame = fs.existsSync(firstFrame);
  if (hasSourceFrame) {
    images.unshift(await toFile(fs.createReadStream(firstFrame), 'source-frame.jpg', { type: 'image/jpeg' }));
  } else {
    console.warn(`[startframe] project=${projectId} нет first.jpg — кадр пойдёт реконструкцией по промту`);
  }

  const size = opts.forceNineSixteen
    ? startFrameSize(1080, 1920, model)
    : startFrameSize(meta.width, meta.height, model);
  const params: Record<string, unknown> = {
    model,
    size,
    quality,
    // сохраняет лица/детали входных фото — критично для identity модели
    input_fidelity: 'high',
    n: 1,
  };

  const edit =
    opts._editFn ??
    (client.images.edit.bind(client.images) as unknown as (
      p: Record<string, unknown>,
    ) => Promise<ImagesResponse>);

  /** Одна попытка с фолбэком input_fidelity (модели без параметра). */
  const attempt = async (prompt: string, imgs: unknown[]): Promise<ImagesResponse> => {
    const p: Record<string, unknown> = { ...params, prompt, image: imgs };
    try {
      return await edit(p);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/input_fidelity/i.test(msg)) {
        delete p.input_fidelity; // модель без поддержки параметра — повтор без него
        return edit(p);
      }
      throw e;
    }
  };

  // Анти-модерационная лестница фразы фигуры: tier1 → tier2 → без фразы.
  // null = ВСЕ ступени отбиты модерацией (не ошибка сети/API — те бросаются).
  const ladder = moderationLadder(imagePrompt);
  const runLadder = async (imgs: unknown[]): Promise<ImagesResponse | null> => {
    for (let i = 0; i < ladder.length; i++) {
      try {
        const r = await attempt(ladder[i]!, imgs);
        if (i > 0) {
          console.warn(
            `[startframe-moderation] project=${projectId} фраза фигуры смягчена до яруса ${i + 1}/${ladder.length} (свап-промт не тронут)`,
          );
        }
        return r;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isModerationRefusal(msg)) {
          if (i < ladder.length - 1) {
            console.warn(`[startframe-moderation] отказ модерации, пробую мягче: ${msg.slice(0, 120)}`);
            continue;
          }
          return null;
        }
        if (e instanceof OpenAI.APIError && e.status === 429) {
          throw new Error(`Лимит или квота OpenAI (429) — повтори позже. ${msg.slice(0, 160)}`);
        }
        throw new Error(`Images API: ${msg.slice(0, 300)}`);
      }
    }
    return null;
  };

  let res = await runLadder(images);
  if (!res && hasSourceFrame) {
    // Вторая ось фолбэка: модерация капризна к edit'у кадра с человеком — пробуем
    // реконструкцию без кадра исходника (поведение v2), кадр менее точный, но флоу живёт
    console.warn(
      `[startframe-moderation] project=${projectId} edit с кадром исходника отбит модерацией — фолбэк на реконструкцию без кадра`,
    );
    res = await runLadder(images.slice(1));
  }
  if (!res) {
    throw new Error('Images API: запрос отбит модерацией на всех ступенях — переформулируй промт (кнопка «Перегенерировать»)');
  }

  console.log(
    `[llm-usage] task=start_frame model=${String(params.model)} size=${size} in=${res.usage?.input_tokens ?? '?'} out=${res.usage?.output_tokens ?? '?'}`,
  );
  recordUsage({
    projectId,
    task: 'start_frame',
    model: String(params.model),
    tokensIn: res.usage?.input_tokens ?? 0,
    tokensOut: res.usage?.output_tokens ?? 0,
  });

  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error('Images API вернул ответ без изображения');

  fs.mkdirSync(startDir(projectId), { recursive: true });
  const file = `start_v${version}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
  fs.writeFileSync(path.join(startDir(projectId), file), Buffer.from(b64, 'base64'));
  return file;
}
