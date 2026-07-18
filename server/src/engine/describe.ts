// Автоописание реф-листа для конструктора моделей. Качество пресета = качество
// его note: vision-модель пишет черновик ПО АНАТОМИИ фирменных пресет-нот
// (см. server/src/presets.ts + docs/prompting-logic.md §7), юзер редактирует.
// Никогда не сохраняется само — только префилл редактируемого поля.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { llmKeyPresent, modelChainFor } from '../config';
import { getLlm } from '../llm/provider';
import { modelRefsDir } from '../storage';
import type { RefRole } from '../../../shared/taxonomy';

// Анатомия сильной ноты (выведена из живых пресетов MotoLola/Lunaria):
// якоря идентичности → КАПС-дискриминаторы → рамка «лист со всех ракурсов» →
// перечисление аутфита → элементы «всегда сохранять» → условный гвард техники.
const DESCRIBE_SYSTEM = `Ты пишешь ЗАМЕТКУ к референс-листу для сервиса видео-свапов. Заметку читает промт-райтер LLM — она должна зафиксировать identity персонажа сильнее, чем это сделает беглый взгляд на фото. Верни JSON {note}.

Правила заметки (по образцу лучших рабочих пресетов):
1. РУССКИЙ язык, плотный телеграфный стиль через запятые/точки с запятой, БЕЗ воды. 250–450 символов.
2. Начни с имени/типа субъекта и рамки: если на фото несколько ракурсов одного персонажа — «референс-лист со всех ракурсов».
3. Якоря идентичности: цвет и причёска волос, глаза, отличительные черты лица (веснушки/улыбка), телосложение если заметно.
4. КЛЮЧЕВЫЕ дискриминаторы — КАПСОМ: цвета («платиново-БЕЛЫЕ волосы»), причёска («ОДНА ДЛИННАЯ КОСА»), уникальные элементы.
5. Аутфит перечисли конкретно: предметы одежды с цветами и деталями, обувь, перчатки, шлем.
6. Несъёмные элементы образа пометь «(часть образа — всегда сохранять на модели в кадре)»: хвосты, уши, аксессуары, которые обязаны остаться при свапе.
7. Для role=vehicle: марка/модель если узнаваема, цвета и уникальные детали КАПСОМ, и ОБЯЗАТЕЛЬНО закончи: «Использовать ТОЛЬКО если в исходнике есть <тип техники>; если его в кадре нет — полностью игнорировать этот референс».
8. Для role=object: что это, цвета/материалы/брендинг, когда использовать.
9. НИКОГДА не упоминай разрешения/форматы/9:16/пиксели. Не выдумывай того, чего нет на фото.`;

const DESCRIBE_JSON_SCHEMA = {
  type: 'object',
  properties: { note: { type: 'string' } },
  required: ['note'],
  additionalProperties: false,
} as const;

const DescribeZ = z.object({ note: z.string() });

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export interface DescribeInput {
  modelId: string;
  file: string;
  role: RefRole;
  modelName: string;
  /** Ноты соседних рефов модели — чтобы identity-часть была консистентной. */
  siblingNotes: string[];
  userId: string;
}

export async function describeRefSheet(input: DescribeInput): Promise<string> {
  if (!llmKeyPresent()) throw new Error('LLM-ключ не настроен на сервере');
  const p = path.join(modelRefsDir(input.modelId), input.file);
  const b64 = fs.readFileSync(p).toString('base64');
  const llm = await getLlm();

  const context = [
    `Имя модели (персонажа): ${input.modelName || 'не задано'}.`,
    `Роль этого референса: ${input.role}.`,
    input.siblingNotes.length
      ? `Заметки других рефов этой модели (держи identity консистентной, не противоречь им):\n${input.siblingNotes
          .slice(0, 4)
          .map((n) => `- ${n.slice(0, 300)}`)
          .join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await llm.structured({
    system: DESCRIBE_SYSTEM,
    parts: [
      { type: 'text', text: `${context}\n\nОпиши этот референс-лист:` },
      {
        type: 'image',
        b64,
        mime: MIME[path.extname(input.file).toLowerCase()] ?? 'image/jpeg',
        detail: 'high', // дискриминаторы образа живут в деталях — low их теряет
      },
    ],
    schemaName: 'describe_ref',
    schema: DESCRIBE_JSON_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 700,
    models: modelChainFor('describe'),
    meta: { userId: input.userId },
  });
  const parsed = DescribeZ.safeParse(raw);
  if (!parsed.success) throw new Error('LLM вернул неожиданный формат описания — попробуй ещё раз');
  const note = parsed.data.note.trim().slice(0, 600);
  if (note.length < 40) throw new Error('Описание вышло слишком коротким — попробуй ещё раз');
  return note;
}
