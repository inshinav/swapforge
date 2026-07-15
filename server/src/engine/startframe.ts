// Генерация стартового кадра по Images API (OpenAI gpt-image-*): imagePrompt + реф-фото →
// готовый кадр в максимальном качестве. Это reference image 1 для Seedance.
import OpenAI, { toFile } from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { projectDir, refsDir } from '../storage';
import type { RefInfo, VideoMeta } from '../../../shared/api-types';

/** Размер под AR исходника: длинная сторона = target, обе стороны кратны 16 (требование gpt-image-2). */
export function startFrameSize(width: number, height: number, longSide = config.imageLongSide): string {
  const snap = (v: number) => Math.max(256, Math.round(v / 16) * 16);
  if (!width || !height) return `${snap(longSide * 0.5625)}x${snap(longSide)}`; // дефолт 9:16
  const ar = width / height;
  if (ar <= 1) return `${snap(longSide * ar)}x${snap(longSide)}`;
  return `${snap(longSide)}x${snap(longSide / ar)}`;
}

export function startDir(projectId: string): string {
  return path.join(projectDir(projectId), 'start');
}

interface ImagesResponse {
  data?: Array<{ b64_json?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export async function generateStartFrame(
  projectId: string,
  version: number,
  imagePrompt: string,
  refs: RefInfo[],
  meta: VideoMeta,
): Promise<string> {
  if (!config.openaiApiKey) {
    throw new Error('Для генерации стартового кадра нужен OpenAI-ключ (Images API)');
  }
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

  const size = startFrameSize(meta.width, meta.height);
  const params: Record<string, unknown> = {
    model: config.openaiImageModel,
    prompt: imagePrompt,
    image: images,
    size,
    quality: config.imageQuality,
    // сохраняет лица/детали входных фото — критично для identity модели
    input_fidelity: 'high',
    n: 1,
  };

  const edit = client.images.edit.bind(client.images) as unknown as (
    p: Record<string, unknown>,
  ) => Promise<ImagesResponse>;

  let res: ImagesResponse;
  try {
    res = await edit(params);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/input_fidelity/i.test(msg)) {
      delete params.input_fidelity; // модель без поддержки параметра — повтор без него
      res = await edit(params);
    } else if (e instanceof OpenAI.APIError && e.status === 429) {
      throw new Error(`Лимит или квота OpenAI (429) — повтори позже. ${msg.slice(0, 160)}`);
    } else {
      throw new Error(`Images API: ${msg.slice(0, 300)}`);
    }
  }

  console.log(
    `[llm-usage] task=start_frame model=${String(params.model)} size=${size} in=${res.usage?.input_tokens ?? '?'} out=${res.usage?.output_tokens ?? '?'}`,
  );

  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error('Images API вернул ответ без изображения');

  fs.mkdirSync(startDir(projectId), { recursive: true });
  const file = `start_v${version}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
  fs.writeFileSync(path.join(startDir(projectId), file), Buffer.from(b64, 'base64'));
  return file;
}
