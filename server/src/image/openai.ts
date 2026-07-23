// OpenAI images/edits провайдер слайдов (SPEC §2). Зеркало боевого вызова startframe.ts:
// toFile-стримы, input_fidelity high с фолбэком, модерация НЕ ошибка (moderated-результат),
// учёт токенов в usage_events через carousel-scope. Гейт оплаты — fail-closed перед вызовом.
import OpenAI, { toFile } from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { recordUsage } from '../usage';
import { requireActiveAttempt } from '../billing/attempts';
import { CAROUSEL_TASKS } from '../../../shared/carousel';
import { imageModelFlexible, isModerationRefusal } from '../engine/startframe';
import { carouselModerationLadder } from '../engine/carousel/blocks';
import type { ImageEditRequest, ImageEditResult, ImageProvider } from './provider';

interface ImagesResponse {
  data?: Array<{ b64_json?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

type EditFn = (params: Record<string, unknown>) => Promise<ImagesResponse>;

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: config.openaiApiKey, maxRetries: 2, timeout: 300_000 });
  }
  return client;
}

/** Негибкая модель не примет 1024x1280 — даунгрейд к фиксированной тройке (кроп делает финализация). */
export function effectiveSlideSize(size: string, model: string): string {
  if (imageModelFlexible(model)) return size;
  const [w, h] = size.split('x').map((v) => Number(v));
  if (!w || !h || w === h) return '1024x1024';
  return h > w ? '1024x1536' : '1536x1024';
}

/** Фабрика с инъекцией вызова для тестов (сеть в тестах заглушена глобально). */
export function createOpenaiImageProvider(editFn?: EditFn): ImageProvider {
  return {
    name: () => 'openai',
    async edit(req: ImageEditRequest): Promise<ImageEditResult> {
      if (!config.openaiApiKey && !editFn) {
        throw new Error('Для генерации слайдов нужен OpenAI-ключ (Images API)');
      }
      // Тестовые инъекции не достигают платного провайдера; боевой вызов — fail-closed.
      if (!editFn) requireActiveAttempt({ carouselId: req.meta.carouselId });
      const model = config.carouselImageModel;
      const size = effectiveSlideSize(req.size, model);

      const images = await Promise.all(
        req.imagePaths.map((p) =>
          toFile(fs.createReadStream(p), path.basename(p), {
            type: MIME[path.extname(p).toLowerCase()] ?? 'image/jpeg',
          }),
        ),
      );
      if (images.length === 0) throw new Error('Слайду не передали ни одного референса');

      const params: Record<string, unknown> = {
        model,
        size,
        quality: req.quality,
        // сохраняет лицо/детали identity-рефов — критично для консистентности персонажа
        input_fidelity: 'high',
        n: 1,
      };
      const edit: EditFn =
        editFn ??
        (getClient().images.edit.bind(getClient().images) as unknown as EditFn);

      const attempt = async (prompt: string): Promise<ImagesResponse> => {
        const p: Record<string, unknown> = { ...params, prompt, image: images };
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

      // Карусельная лестница смягчения (SPEC §2); все ступени отбиты → moderated-результат,
      // НЕ ошибка: слайд станет moderated и будет исключён из settle (SPEC §5/§7).
      const ladder = carouselModerationLadder(req.prompt);
      let res: ImagesResponse | null = null;
      for (let i = 0; i < ladder.length; i++) {
        try {
          res = await attempt(ladder[i]!);
          if (i > 0) {
            console.warn(
              `[carousel-moderation] carousel=${req.meta.carouselId} slide=${req.meta.slideId} промт смягчён до яруса ${i + 1}/${ladder.length}`,
            );
          }
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (isModerationRefusal(msg)) {
            if (i < ladder.length - 1) continue;
            return { b64: '', model, tokensIn: 0, tokensOut: 0, moderated: true };
          }
          if (e instanceof OpenAI.APIError && e.status === 429) {
            throw new Error(`Лимит или квота OpenAI (429) — повтори позже. ${msg.slice(0, 160)}`);
          }
          throw new Error(`Images API: ${msg.slice(0, 300)}`);
        }
      }
      if (!res) return { b64: '', model, tokensIn: 0, tokensOut: 0, moderated: true };

      const tokensIn = res.usage?.input_tokens ?? 0;
      const tokensOut = res.usage?.output_tokens ?? 0;
      console.log(
        `[llm-usage] task=${CAROUSEL_TASKS.slide} model=${model} size=${size} in=${tokensIn} out=${tokensOut}`,
      );
      recordUsage({
        projectId: req.meta.carouselId,
        generationId: req.meta.slideId,
        userId: req.meta.userId,
        task: CAROUSEL_TASKS.slide,
        model,
        tokensIn,
        tokensOut,
      });

      const b64 = res.data?.[0]?.b64_json;
      if (!b64) throw new Error('Images API вернул ответ без изображения');
      return { b64, model, tokensIn, tokensOut };
    },
  };
}

export const openaiImageProvider: ImageProvider = createOpenaiImageProvider();
