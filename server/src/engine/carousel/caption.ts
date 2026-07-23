// Caption Engine (SPEC §4): идея+раскадровка+persona → подпись (EN default / RU по выбору)
// + 10–15 хэштегов + hook-строка. Структуру может подсказывать PatternCard, текст всегда
// оригинальный; подписи замайненных источников в контекст НЕ попадают (SPEC §3).
import { getLlm, type ContentPart, type LlmClient } from '../../llm/provider';
import { modelChainFor } from '../../config';
import {
  CAPTION_JSON_SCHEMA,
  CAROUSEL_TASKS,
  CaptionZ,
  type Caption,
} from '../../../../shared/carousel';
import { carouselCtx, carouselTestLlm, patternHintsBlock, personaNote } from './engines';

export const CAPTION_SYSTEM = [
  'You write Instagram captions for a UGC photo carousel of an AI persona.',
  'Rules:',
  '- hookLine is the scroll-stopping first line (visible before "more");',
  '- caption: personal, first-person voice of the persona, 2-5 short paragraphs, no ad tone,',
  '  a light call-to-action at the end (comment/save/DM);',
  '- 10-15 hashtags: mix of niche and broad, no banned/spammy tags, each starts with #;',
  '- language: as requested (default English);',
  '- never copy caption text from anywhere — always original. JSON only.',
].join('\n');

export interface CaptionEngineInput {
  carouselId: string;
  userId: string;
  opId: string;
  language?: 'en' | 'ru';
  patternHints?: string[];
}

export async function runCaptionEngine(input: CaptionEngineInput, llm?: LlmClient): Promise<Caption> {
  const ctx = carouselCtx(input.carouselId);
  if (!ctx.idea_json) throw new Error('Нет идеи — подпись не из чего собирать');
  const client = llm ?? carouselTestLlm() ?? (await getLlm());
  const parts: ContentPart[] = [
    {
      type: 'text',
      text:
        `LANGUAGE: ${input.language === 'ru' ? 'Russian' : 'English'}\n` +
        `PERSONA: ${personaNote(ctx) || 'young female lifestyle creator'}\n` +
        `IDEA: ${ctx.idea_json}\n` +
        (ctx.storyboard_json ? `STORYBOARD: ${ctx.storyboard_json.slice(0, 2000)}` : '') +
        patternHintsBlock(input.patternHints ?? []),
    },
  ];
  const raw = await client.structured({
    system: CAPTION_SYSTEM,
    parts,
    schemaName: CAROUSEL_TASKS.caption,
    schema: CAPTION_JSON_SCHEMA,
    maxTokens: 1500,
    models: modelChainFor('generate'),
    meta: { carouselId: input.carouselId, userId: input.userId, generationId: input.opId },
  });
  return CaptionZ.parse(raw);
}
