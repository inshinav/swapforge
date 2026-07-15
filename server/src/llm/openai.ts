import OpenAI from 'openai';
import { config } from '../config';
import { parseJsonLoose, type LlmClient, type StructuredRequest } from './provider';

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: config.openaiApiKey,
      maxRetries: 3, // SDK сам ретраит 429/5xx с бэкоффом и уважает retry-after
      timeout: 300_000,
    });
  }
  return client;
}

type MsgPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

function toContent(req: StructuredRequest): MsgPart[] {
  return req.parts.map((p): MsgPart =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : {
          type: 'image_url',
          image_url: { url: `data:${p.mime};base64,${p.b64}`, detail: p.detail ?? 'auto' },
        },
  );
}

function humanError(e: unknown): Error {
  if (e instanceof OpenAI.APIError) {
    const tail = (e.message || '').slice(0, 200);
    if (e.status === 401) return new Error(`OpenAI не принял ключ (401). ${tail}`);
    if (e.status === 429)
      return new Error(`Лимит или квота OpenAI (429) — подожди пару минут и повтори. ${tail}`);
    if (e.status && e.status >= 500)
      return new Error(`OpenAI временно недоступен (${e.status}) — повтори позже. ${tail}`);
    return new Error(`Ошибка OpenAI (${e.status ?? '?'}): ${tail}`);
  }
  if (e instanceof Error && e.name === 'APIConnectionTimeoutError')
    return new Error('OpenAI не ответил за 5 минут — повтори попытку');
  return e instanceof Error ? e : new Error(String(e));
}

function isSchemaUnsupported(e: unknown): boolean {
  return (
    e instanceof OpenAI.APIError &&
    e.status === 400 &&
    /response_format|json_schema|schema/i.test(e.message ?? '')
  );
}

async function complete(
  req: StructuredRequest,
  responseFormat: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'],
  systemSuffix = '',
): Promise<unknown> {
  const res = await getClient().chat.completions.create({
    model: req.model ?? config.openaiModel,
    messages: [
      { role: 'system', content: req.system + systemSuffix },
      { role: 'user', content: toContent(req) },
    ],
    response_format: responseFormat,
    max_completion_tokens: req.maxTokens ?? 8000,
  });
  // учёт расхода: смотреть journalctl -u swapforge | grep llm-usage (детально — platform.openai.com/usage)
  console.log(
    `[llm-usage] task=${req.schemaName} model=${res.model} in=${res.usage?.prompt_tokens ?? '?'} out=${res.usage?.completion_tokens ?? '?'}`,
  );
  const choice = res.choices[0];
  if (!choice) throw new Error('OpenAI вернул пустой ответ');
  if (choice.finish_reason === 'length')
    throw new Error('Ответ LLM обрезан по токенам — повтори (или сократи ролик)');
  const text = choice.message?.content;
  if (!text) throw new Error('OpenAI вернул ответ без контента');
  return parseJsonLoose(text);
}

export const openaiClient: LlmClient = {
  name: () => `openai/${config.openaiModel}`,
  async structured(req) {
    try {
      // Основной путь: строгая json_schema
      return await complete(req, {
        type: 'json_schema',
        json_schema: { name: req.schemaName, schema: req.schema, strict: true },
      });
    } catch (e) {
      if (isSchemaUnsupported(e)) {
        // Фолбэк для моделей без json_schema: json_object + схема текстом (проверено на gpt-5.5 в yasno)
        try {
          return await complete(
            req,
            { type: 'json_object' },
            `\n\nRespond with a single JSON object that STRICTLY matches this JSON Schema (no extra keys, all keys present):\n${JSON.stringify(req.schema)}`,
          );
        } catch (e2) {
          throw humanError(e2);
        }
      }
      throw humanError(e);
    }
  },
};
