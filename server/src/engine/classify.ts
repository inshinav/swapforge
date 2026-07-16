// Автоопределение роли референса по одной картинке: модель / транспорт / объект.
// Дёшево (low detail, крошечный вывод), с жёстким таймаутом; при любом сбое — null,
// вызывающий откатывается на позиционную эвристику. Ручной выбор всегда главнее.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { llmKeyPresent, modelChainFor } from '../config';
import { getLlm } from '../llm/provider';
import { refsDir } from '../storage';
import type { RefRole } from '../../../shared/taxonomy';

const CLASSIFY_SYSTEM = `You classify ONE reference photo for a video subject-swap. Return JSON.
- role: "model" if the photo's main subject is a person/character; "vehicle" if it is a motorcycle, car, bike or other vehicle; "object" for anything else (product, prop, animal).
- note: a short ENGLISH visual descriptor of the subject useful for prompt-writing (outfit/colors/design cues), max 12 words. Example: "red-haired woman, black leather jacket, orange bikini top".`;

const CLASSIFY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    role: { type: 'string', enum: ['model', 'vehicle', 'object'] },
    note: { type: 'string' },
  },
  required: ['role', 'note'],
  additionalProperties: false,
} as const;

const ClassifyZ = z.object({
  role: z.enum(['model', 'vehicle', 'object']),
  note: z.string(),
});

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export interface RefClassification {
  role: RefRole;
  note: string;
}

export async function classifyRef(
  projectId: string,
  file: string,
  timeoutMs = 8000,
): Promise<RefClassification | null> {
  if (!llmKeyPresent()) return null;
  try {
    const p = path.join(refsDir(projectId), file);
    const b64 = fs.readFileSync(p).toString('base64');
    const llm = await getLlm();
    const call = llm.structured({
      system: CLASSIFY_SYSTEM,
      parts: [
        { type: 'text', text: 'Classify this reference photo:' },
        { type: 'image', b64, mime: MIME[path.extname(file).toLowerCase()] ?? 'image/jpeg', detail: 'low' },
      ],
      schemaName: 'classify_ref',
      schema: CLASSIFY_JSON_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 200,
      models: modelChainFor('classify'),
      meta: { projectId },
    });
    // жёсткий таймаут: загрузка рефа не должна ждать LLM дольше пары секунд
    const raw = await Promise.race([
      call,
      new Promise((_, rej) => setTimeout(() => rej(new Error('classify timeout')), timeoutMs)),
    ]);
    const parsed = ClassifyZ.safeParse(raw);
    if (!parsed.success) return null;
    return { role: parsed.data.role, note: parsed.data.note.slice(0, 120) };
  } catch (e) {
    console.warn(`[classify] реф не классифицирован: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
