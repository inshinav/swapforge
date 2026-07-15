// Модели, доступные для выбора в UI (per задача). Сервер валидирует выбор по этим спискам;
// env-переменные (OPENAI_MODEL_*) задают дефолт, выбор в UI его перекрывает per-запрос.

export interface ModelOption {
  id: string;
  ru: string;
  hint: string;
}

export const ANALYZE_MODELS: ModelOption[] = [
  { id: 'gpt-5.5', ru: '👑 Топ · gpt-5.5', hint: 'максимум качества карты рисков' },
  { id: 'gpt-5.4-mini', ru: '⚡ Быстро · gpt-5.4-mini', hint: 'в разы дешевле и быстрее; кадры — главная статья расхода' },
];

export const GENERATE_MODELS: ModelOption[] = [
  { id: 'gpt-5.5', ru: '👑 Топ · gpt-5.5', hint: 'самые точные промты' },
  { id: 'gpt-5.4-mini', ru: '⚡ Быстро · gpt-5.4-mini', hint: 'секунды вместо минуты, дешевле' },
  { id: 'gpt-5.6-sol', ru: '🧪 Превью · 5.6-sol', hint: 'эксперимент, поведение может отличаться' },
  { id: 'gpt-5.6-luna', ru: '🧪 Превью · 5.6-luna', hint: 'эксперимент' },
  { id: 'gpt-5.6-terra', ru: '🧪 Превью · 5.6-terra', hint: 'эксперимент' },
];

export const IMAGE_MODELS: ModelOption[] = [
  { id: 'gpt-image-2', ru: '👑 Топ 2K · gpt-image-2', hint: 'до 2048 по длинной стороне, лучший перенос лица' },
  { id: 'gpt-image-1.5', ru: '⚖️ Средне · gpt-image-1.5', hint: 'до 1536, дешевле' },
  { id: 'gpt-image-1-mini', ru: '⚡ Черновик · image-1-mini', hint: 'быстрые дешёвые прикидки композиции' },
];

export const IMAGE_QUALITIES = ['high', 'medium', 'low'] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

export function isAllowed(list: ModelOption[], id: string | undefined): id is string {
  return !!id && list.some((m) => m.id === id);
}

/** Гибкие размеры (кратно 16) поддерживает только gpt-image-2; у остальных — фиксированная тройка. */
export function imageModelFlexible(id: string): boolean {
  return id === 'gpt-image-2';
}
