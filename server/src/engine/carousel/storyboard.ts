// Storyboard Engine (SPEC §4): выбранная идея → пер-слайдовая раскадровка (EN-поля для
// промтов) + anchor-нота. Пользователь потом правит слайды PATCH-ем до генерации.
import { getLlm, type ContentPart, type LlmClient } from '../../llm/provider';
import { modelChainFor } from '../../config';
import {
  CAROUSEL_TASKS,
  CarouselIdeaZ,
  STORYBOARD_JSON_SCHEMA,
  StoryboardZ,
  type Storyboard,
} from '../../../../shared/carousel';
import { carouselCtx, carouselTestLlm, patternHintsBlock, personaNote, scenesBrief } from './engines';

export const STORYBOARD_SYSTEM = [
  'You are a shot planner for a UGC photo carousel of an AI persona.',
  'You receive the chosen idea, the persona and the available scenes.',
  'Produce the storyboard strictly matching the idea\'s slideCount. Rules:',
  '- slide 1 is the HOOK and the anchor: slides 2..N must be shootable in the same look;',
  '- action/outfit/camera are in ENGLISH — they go verbatim into image prompts;',
  '- action = what the person is doing (concrete, candid); camera = who/how is shooting',
  '  (arm-length selfie, friend POV, low angle, mirror shot...);',
  '- outfit stays CONSISTENT across slides unless the idea explicitly changes it;',
  '- sceneId only from the provided ids; useProductRef=true only where the product must appear;',
  '- anchorNote: what slide 1 locks for the rest (outfit, hair, light, color grade).',
  'JSON only.',
].join('\n');

export interface StoryboardEngineInput {
  carouselId: string;
  userId: string;
  opId: string;
  patternHints?: string[];
}

export async function runStoryboardEngine(
  input: StoryboardEngineInput,
  llm?: LlmClient,
): Promise<Storyboard> {
  const ctx = carouselCtx(input.carouselId);
  if (!ctx.idea_json) throw new Error('Сначала выбери идею');
  const idea = CarouselIdeaZ.parse(JSON.parse(ctx.idea_json));
  const client = llm ?? carouselTestLlm() ?? (await getLlm());
  const parts: ContentPart[] = [
    {
      type: 'text',
      text:
        `IDEA (title/hook/concept in Russian, execute in English):\n${JSON.stringify(idea)}\n\n` +
        `PERSONA: ${personaNote(ctx) || 'young female lifestyle creator'}\n\n` +
        `AVAILABLE SCENES (${ctx.location_pack}):\n${scenesBrief(ctx)}` +
        patternHintsBlock(input.patternHints ?? []),
    },
  ];
  const raw = await client.structured({
    system: STORYBOARD_SYSTEM,
    parts,
    schemaName: CAROUSEL_TASKS.storyboard,
    schema: STORYBOARD_JSON_SCHEMA,
    maxTokens: 3000,
    models: modelChainFor('generate'),
    meta: { carouselId: input.carouselId, userId: input.userId, generationId: input.opId },
  });
  const storyboard = StoryboardZ.parse(raw);
  if (storyboard.slides.length !== idea.slideCount) {
    // Мягкая нормализация: обрезаем/жалуемся, но не падаем — юзер правит руками.
    console.warn(
      `[carousel-storyboard] carousel=${input.carouselId} LLM дал ${storyboard.slides.length} слайдов вместо ${idea.slideCount}`,
    );
  }
  return storyboard;
}
