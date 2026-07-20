import { config } from '../config';
import { requireActiveAttempt } from '../billing/attempts';

export type ImageDetail = 'low' | 'high' | 'auto';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; b64: string; mime: string; detail?: ImageDetail };

export interface StructuredRequest {
  system: string;
  parts: ContentPart[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  /** Цепочка моделей: первая — основная, дальше авто-фолбэки при сбое (см. config.modelChainFor). */
  models?: string[];
  /** Привязка расхода к проекту/генерации (usage_events). */
  meta?: { projectId?: string | null; generationId?: string | null; userId?: string | null };
}

export interface LlmClient {
  name(): string;
  /** Один запрос → JSON-объект по схеме (structured output). Бросает Error с русским сообщением. */
  structured(req: StructuredRequest): Promise<unknown>;
}

export async function getLlm(): Promise<LlmClient> {
  let client: LlmClient;
  if (config.llmProvider === 'anthropic') {
    if (!config.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY не настроен — добавь его в /etc/swapforge.env');
    }
    const { anthropicClient } = await import('./anthropic');
    client = anthropicClient;
  } else {
    if (!config.openaiApiKey) {
      throw new Error('OPENAI_API_KEY не настроен — добавь его в /etc/swapforge.env и перезапусти сервис');
    }
    const { openaiClient } = await import('./openai');
    client = openaiClient;
  }
  return {
    name: () => client.name(),
    async structured(req) {
      requireActiveAttempt(req.meta ?? {});
      return client.structured(req);
    },
  };
}

/** Ответ LLM бывает в ```json-заборах — счищаем и парсим. */
export function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    // последняя попытка: вырезать от первой { до последней }
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('LLM вернул не-JSON ответ');
  }
}
