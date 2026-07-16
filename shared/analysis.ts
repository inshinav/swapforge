// Структура vision-анализа ролика: zod — для рантайм-валидации ответа LLM,
// JSON Schema (ручная, strict-mode: все поля required, additionalProperties:false) — для structured output.

import { z } from 'zod';

export const ArtifactTypeZ = z.enum([
  'identity_bleed',
  'world_drift',
  'temporal_drift',
  'pasted_on',
  'cross_wiring',
]);

export const AnalysisZ = z.object({
  storyboard: z.array(
    z.object({
      index: z.number(),
      startSec: z.number(),
      endSec: z.number(),
      camera: z.string(),
      action: z.string(),
      framing: z.string(),
    }),
  ),
  world: z.object({
    location: z.string(),
    timeOfDay: z.string(),
    light: z.string(),
    weather: z.string(),
    background: z.array(z.string()),
    reflections: z.array(z.string()),
    surfaces: z.array(z.string()),
    /** Наложенный текст/графика (капшены, стикеры, вотермарки) — с содержимым, позицией, таймингом.
     *  В старых analysis_json поля нет — читать с `?? []`. */
    overlayText: z.array(z.string()).optional().default([]),
  }),
  subjects: z.array(
    z.object({
      kind: z.string(),
      description: z.string(),
      pose: z.string(),
      contact: z.array(z.string()),
      prominence: z.string(),
    }),
  ),
  risks: z.array(
    z.object({
      moment: z.string(),
      artifactType: ArtifactTypeZ,
      why: z.string(),
      suppressorLine: z.string(),
    }),
  ),
  startFrame: z.object({
    description: z.string(),
    composition: z.string(),
    subjectPlacement: z.string(),
    lightNote: z.string(),
  }),
  tags: z.array(z.string()),
});

export type Analysis = z.infer<typeof AnalysisZ>;

const str = { type: 'string' } as const;
const num = { type: 'number' } as const;
const arr = (items: unknown) => ({ type: 'array', items }) as const;
const obj = (properties: Record<string, unknown>) =>
  ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }) as const;

export const ANALYSIS_JSON_SCHEMA = obj({
  storyboard: arr(
    obj({ index: num, startSec: num, endSec: num, camera: str, action: str, framing: str }),
  ),
  world: obj({
    location: str,
    timeOfDay: str,
    light: str,
    weather: str,
    background: arr(str),
    reflections: arr(str),
    surfaces: arr(str),
    overlayText: arr(str),
  }),
  subjects: arr(
    obj({ kind: str, description: str, pose: str, contact: arr(str), prominence: str }),
  ),
  risks: arr(
    obj({
      moment: str,
      artifactType: {
        type: 'string',
        enum: ['identity_bleed', 'world_drift', 'temporal_drift', 'pasted_on', 'cross_wiring'],
      },
      why: str,
      suppressorLine: str,
    }),
  ),
  startFrame: obj({ description: str, composition: str, subjectPlacement: str, lightNote: str }),
  tags: arr(str),
});

// Результат генерации промтов
export const PromptPairZ = z.object({
  imagePrompt: z.string(),
  videoPrompt: z.string(),
  notes: z.string(),
});
export type PromptPair = z.infer<typeof PromptPairZ>;

export const PROMPT_PAIR_JSON_SCHEMA = obj({
  imagePrompt: str,
  videoPrompt: str,
  notes: str,
});
