// Idea Engine (SPEC §4): persona + сцены пака (+пожелание, +PatternCards) → 3–5 идей.
// UI-тексты RU, промт-инжиниринг EN; выход строго по IDEAS_JSON_SCHEMA.
import { getLlm, type ContentPart, type LlmClient } from '../../llm/provider';
import { modelChainFor } from '../../config';
import {
  CAROUSEL_TASKS,
  CarouselIdeasZ,
  IDEAS_JSON_SCHEMA,
  type CarouselIdeas,
} from '../../../../shared/carousel';
import { carouselCtx, carouselTestLlm, patternHintsBlock, personaNote, scenesBrief } from './engines';

export const IDEAS_SYSTEM = [
  'You are a creative director for UGC photo carousels of an AI persona on Instagram.',
  'You receive: the persona description, the available location scenes (id + description),',
  'optionally the creator\'s wish and proven structural patterns.',
  'Produce 3-5 distinct carousel ideas. Rules:',
  '- title, hook and concept are in RUSSIAN (they are shown to a Russian-speaking creator);',
  '- hook is the first-slide attention grab; concept explains the slide flow in 2-3 sentences;',
  '- sceneIds must use ONLY the provided scene ids, in the intended slide order;',
  '- slideCount between 2 and 10 and consistent with the concept;',
  '- ugcPreset: raw (максимально любительски), casual (обычный телефонник), polished (аккуратный).',
  'Ideas must feel like a real person\'s candid phone content, not an ad. JSON only.',
].join('\n');

export interface IdeaEngineInput {
  carouselId: string;
  userId: string;
  /** id операции микро-hold — обязателен для атрибуции затрат (SPEC §7). */
  opId: string;
  wish?: string;
  patternHints?: string[];
}

export async function runIdeaEngine(input: IdeaEngineInput, llm?: LlmClient): Promise<CarouselIdeas> {
  const ctx = carouselCtx(input.carouselId);
  const client = llm ?? carouselTestLlm() ?? (await getLlm());
  const parts: ContentPart[] = [
    {
      type: 'text',
      text:
        `PERSONA: ${personaNote(ctx) || 'young female lifestyle creator (no detailed notes)'}\n\n` +
        `AVAILABLE SCENES (${ctx.location_pack}):\n${scenesBrief(ctx)}` +
        (input.wish?.trim() ? `\n\nCREATOR'S WISH: ${input.wish.trim().slice(0, 500)}` : '') +
        patternHintsBlock(input.patternHints ?? []),
    },
  ];
  const raw = await client.structured({
    system: IDEAS_SYSTEM,
    parts,
    schemaName: CAROUSEL_TASKS.idea,
    schema: IDEAS_JSON_SCHEMA,
    maxTokens: 2500,
    models: modelChainFor('generate'),
    meta: { carouselId: input.carouselId, userId: input.userId, generationId: input.opId },
  });
  return CarouselIdeasZ.parse(raw);
}
