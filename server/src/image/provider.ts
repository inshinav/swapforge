// ImageProvider: абстракция генерации слайдов (SPEC §0.8) — вендор сменяем без правки движка.
// Селектор по образцу llm/provider.ts: lazy-import реализации по config. Гейт оплаты и
// recordUsage живут ВНУТРИ реализаций (как в llm-слое), движок карусели про них не знает.
import { config } from '../config';

export interface ImageEditMeta {
  /** Скоуп оплаты и атрибуции затрат (usage_events.project_id). */
  carouselId: string;
  /** Явный плательщик — обязателен (SPEC §7). */
  userId: string;
  /** Слайд для пер-слайдовой атрибуции (usage_events.generation_id). */
  slideId: string;
}

export interface ImageEditRequest {
  /** Готовый EN-промт слайда (детерминированная сборка, SPEC §2). */
  prompt: string;
  /** Абсолютные пути референсов; порядок обязан совпадать с нумерацией в промте. */
  imagePaths: string[];
  /** '1024x1280' | '1024x1024' | '1024x1536' (гард гибкости модели — в реализации). */
  size: string;
  quality: string;
  meta: ImageEditMeta;
}

export interface ImageEditResult {
  /** PNG в base64 — персист на диск делает движок, не провайдер. */
  b64: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Провайдер упёрся в модерацию (после всех своих смягчений) — слайд станет moderated. */
  moderated?: boolean;
}

export interface ImageProvider {
  name(): string;
  edit(req: ImageEditRequest): Promise<ImageEditResult>;
}

let cached: ImageProvider | null = null;

export async function getImageProvider(): Promise<ImageProvider> {
  if (cached) return cached;
  if (config.carouselImageProvider === 'mock') {
    const { mockImageProvider } = await import('./mock');
    cached = mockImageProvider;
    return cached;
  }
  const { openaiImageProvider } = await import('./openai');
  cached = openaiImageProvider;
  return cached;
}

/** Только для тестов: сбросить/подменить синглтон. */
export function setImageProviderForTests(p: ImageProvider | null): void {
  cached = p;
}
