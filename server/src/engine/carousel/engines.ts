// Общий контекст LLM-движков карусели (SPEC §4): persona-нота модели + сцены пака.
// Few-shot слот PatternCards (P3.4): структурные подсказки замайненных карточек —
// ТОЛЬКО обобщённые признаки, никогда контент источника (SPEC §3).
import { getDb } from '../../db';
import { variantRefs } from '../../models';
import { getLocationPack } from './locations';
import type { LlmClient } from '../../llm/provider';

// Тест-инъекция LLM для всех трёх движков (сеть в тестах заглушена глобально).
let testLlm: LlmClient | null = null;
export function setCarouselLlmForTests(llm: LlmClient | null): void {
  testLlm = llm;
}
export function carouselTestLlm(): LlmClient | null {
  return testLlm;
}

export interface CarouselCtxRow {
  id: string;
  user_id: string;
  model_id: string | null;
  variant_id: string | null;
  location_pack: string;
  idea_json: string | null;
  storyboard_json: string | null;
  slide_count: number;
}

export function carouselCtx(carouselId: string): CarouselCtxRow {
  const row = getDb()
    .prepare(
      `SELECT id, user_id, model_id, variant_id, location_pack, idea_json, storyboard_json, slide_count
         FROM carousel_projects WHERE id=?`,
    )
    .get(carouselId) as CarouselCtxRow | undefined;
  if (!row) throw new Error('Карусель не найдена');
  return row;
}

/** Persona-нота: note/auto_note identity-рефов модели (пусто — не фатально для идей). */
export function personaNote(ctx: CarouselCtxRow): string {
  if (!ctx.model_id || !ctx.variant_id) return '';
  try {
    return variantRefs(ctx.model_id, ctx.variant_id)
      .filter((r) => r.role === 'model')
      .map((r) => (r.note || r.auto_note).trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 1200);
  } catch {
    return '';
  }
}

/** Сцены пака для промта движков: id + короткое EN-описание. */
export function scenesBrief(ctx: CarouselCtxRow): string {
  const pack = getLocationPack(ctx.location_pack);
  if (!pack) throw new Error(`Неизвестный пак локаций: ${ctx.location_pack}`);
  return pack.scenes.map((s) => `- ${s.id}: ${s.promptBlock.slice(0, 140)}`).join('\n');
}

/** Few-shot блок из PatternCard-структур (пока подаётся пустым — заполнит Reference Miner). */
export function patternHintsBlock(hints: string[]): string {
  if (!hints.length) return '';
  return (
    '\nPROVEN VIRAL PATTERNS (structural inspiration only — never copy specific content):\n' +
    hints
      .slice(0, 5)
      .map((h, i) => `${i + 1}. ${h.slice(0, 300)}`)
      .join('\n')
  );
}
