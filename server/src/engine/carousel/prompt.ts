// Сборка EN-промта слайда: строго детерминированная конкатенация блоков (SPEC §2).
// Порядок частей неизменен; нумерация референсов в тексте обязана совпадать с порядком
// массива изображений, который передаётся провайдеру (защита от cross-wiring).
import type { StoryboardSlide, UgcPreset } from '../../../../shared/carousel';
import {
  ANTI_ARTIFACT_GUARDRAILS,
  buildAnchorBlock,
  buildIdentityBlock,
  buildLookBlock,
  buildProductBlock,
  buildPropsBlock,
  formatBlock,
  UGC_PRESETS,
} from './blocks';
import type { LocationScene } from './locations';

/** Мягкий кап: длиннее — не ошибка, но сигнал распухшего storyboard-поля. */
export const SLIDE_PROMPT_SOFT_MAX_WORDS = 320;

export interface SlidePromptInput {
  slide: StoryboardSlide;
  scene: LocationScene;
  /** note/auto_note модели дословно. */
  modelNote: string;
  identityRefCount: number;
  ugcPreset: UgcPreset;
  aspect: '4:5' | '1:1';
  /** Номер референса-якоря (слайды 2..N); undefined для якорного слайда. */
  anchorRefIndex?: number;
  /** Номер product-референса и его заметка (legacy-путь без карусельных рефов). */
  productRefIndex?: number;
  productNote?: string;
  /** P8: номер фото лука (одежда берётся с него). */
  lookRefIndex?: number;
  /** P8: пропсы (мотоцикл/шлем...): первый номер + сколько подряд. */
  propsFirstIndex?: number;
  propsCount?: number;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function buildSlidePrompt(input: SlidePromptInput): string {
  const parts: string[] = [];
  parts.push(buildIdentityBlock(input.modelNote, input.identityRefCount));
  if (input.anchorRefIndex !== undefined) parts.push(buildAnchorBlock(input.anchorRefIndex));
  if (input.lookRefIndex !== undefined) parts.push(buildLookBlock(input.lookRefIndex));
  if (input.propsFirstIndex !== undefined && (input.propsCount ?? 0) > 0) {
    parts.push(buildPropsBlock(input.propsFirstIndex, input.propsCount!, input.slide.propNote));
  }
  if (input.productRefIndex !== undefined) {
    parts.push(buildProductBlock(input.productRefIndex, input.productNote ?? ''));
  }
  const action = input.slide.action.trim();
  const outfit = input.slide.outfit.trim();
  const camera = input.slide.camera.trim();
  parts.push(
    [
      `The person is ${action || 'present in the scene'}.`,
      outfit ? `Wearing ${outfit}.` : '',
      camera ? `Shot as ${camera}.` : '',
      input.scene.promptBlock,
    ]
      .filter(Boolean)
      .join(' '),
  );
  parts.push(UGC_PRESETS[input.ugcPreset]);
  parts.push(formatBlock(input.aspect));
  parts.push(ANTI_ARTIFACT_GUARDRAILS);
  const prompt = parts.join(' ');
  if (wordCount(prompt) > SLIDE_PROMPT_SOFT_MAX_WORDS) {
    console.warn(
      `[carousel-prompt] слайд ${input.slide.idx}: промт ${wordCount(prompt)} слов (мягкий кап ${SLIDE_PROMPT_SOFT_MAX_WORDS}) — проверь поля storyboard`,
    );
  }
  return prompt;
}
