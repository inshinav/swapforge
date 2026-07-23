// Vision-QC слайда (SPEC §5): identity/артефакты/UGC-реализм/соответствие сцене 0–10.
// Пороговое решение — чистая функция (тестируется без LLM); vision-вызов идёт через
// существующий llm-слой с carousel-scope метой (атрибуция затрат на слайд обязательна).
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config';
import { getLlm, type ContentPart, type LlmClient } from '../../llm/provider';
import { CAROUSEL_TASKS, QC_JSON_SCHEMA, QcVerdictZ, type QcVerdict } from '../../../../shared/carousel';

export const QC_SYSTEM = [
  'You are a strict photo quality inspector for AI-generated UGC carousel slides.',
  'You receive the GENERATED SLIDE first, then IDENTITY REFERENCE photos of the person.',
  'Grade honestly, do not flatter:',
  '- identity (0-10): does the person match the identity references (face, hair, body)?',
  '- artifacts (0-10): 10 = clean; deduct hard for wrong hands/fingers, extra limbs, warped features, garbled text, plastic waxy skin.',
  '- realism (0-10): does it look like a real candid smartphone photo (not glossy AI art)?',
  '- sceneMatch: does the image match the described scene and action?',
  'Answer with JSON only.',
].join('\n');

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function imagePart(file: string, detail: 'low' | 'high'): ContentPart {
  return {
    type: 'image',
    b64: fs.readFileSync(file).toString('base64'),
    mime: MIME[path.extname(file).toLowerCase()] ?? 'image/jpeg',
    detail,
  };
}

/** Пороговое решение (SPEC §5): sceneMatch НЕ блокирует (мягкий сигнал в UI). */
export function qcPasses(v: QcVerdict): boolean {
  return (
    v.identity >= config.carouselQcIdentityMin &&
    v.artifacts >= config.carouselQcArtifactsMin &&
    v.realism >= config.carouselQcRealismMin
  );
}

export interface SlideQcInput {
  slideImagePath: string;
  identityRefPaths: string[];
  /** Что должно быть в кадре: action + сцена (EN). */
  sceneDescription: string;
  carouselId: string;
  userId: string;
  slideId: string;
}

export async function runSlideQc(input: SlideQcInput, llm?: LlmClient): Promise<QcVerdict> {
  const client = llm ?? (await getLlm());
  const parts: ContentPart[] = [
    { type: 'text', text: `SCENE EXPECTED: ${input.sceneDescription}` },
    { type: 'text', text: 'GENERATED SLIDE:' },
    imagePart(input.slideImagePath, 'high'),
    { type: 'text', text: 'IDENTITY REFERENCES:' },
    ...input.identityRefPaths.map((p) => imagePart(p, 'low')),
  ];
  const raw = await client.structured({
    system: QC_SYSTEM,
    parts,
    schemaName: CAROUSEL_TASKS.qc,
    schema: QC_JSON_SCHEMA,
    maxTokens: 700,
    meta: { carouselId: input.carouselId, userId: input.userId, generationId: input.slideId },
  });
  return QcVerdictZ.parse(raw);
}
