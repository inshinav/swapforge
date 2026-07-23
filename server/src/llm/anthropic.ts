import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { recordUsage } from '../usage';
import { parseJsonLoose, type LlmClient, type StructuredRequest } from './provider';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 3, timeout: 300_000 });
  }
  return client;
}

type AnthropicPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

function toContent(req: StructuredRequest): AnthropicPart[] {
  return req.parts.map((p): AnthropicPart =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.b64 } },
  );
}

function firstText(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const block = content.find((b) => b.type === 'text');
  if (!block?.text) throw new Error('Anthropic вернул ответ без текста');
  return block.text;
}

async function complete(req: StructuredRequest, withSchemaFormat: boolean): Promise<unknown> {
  const params: Record<string, unknown> = {
    model: req.models?.[0] ?? config.anthropicModel,
    max_tokens: req.maxTokens ?? 8000,
    system: withSchemaFormat
      ? req.system
      : `${req.system}\n\nRespond with a single JSON object that STRICTLY matches this JSON Schema:\n${JSON.stringify(req.schema)}`,
    messages: [{ role: 'user', content: toContent(req) }],
  };
  if (withSchemaFormat) {
    params.output_config = { format: { type: 'json_schema', schema: req.schema } };
  }
  const create = getClient().messages.create.bind(getClient()) as unknown as (
    p: Record<string, unknown>,
  ) => Promise<unknown>;
  const res = await create(params);
  const usage = (res as { usage?: { input_tokens?: number; output_tokens?: number }; model?: string });
  console.log(
    `[llm-usage] task=${req.schemaName} model=${usage.model ?? params.model} in=${usage.usage?.input_tokens ?? '?'} out=${usage.usage?.output_tokens ?? '?'}`,
  );
  if (usage.usage) {
    recordUsage({
      // carouselId атрибуцируется в ту же колонку scope-id (без FK — переживает удаления)
      projectId: req.meta?.projectId ?? req.meta?.carouselId ?? req.meta?.collectionId,
      generationId: req.meta?.generationId,
      userId: req.meta?.userId,
      task: req.schemaName,
      model: String(usage.model ?? params.model),
      tokensIn: usage.usage.input_tokens ?? 0,
      tokensOut: usage.usage.output_tokens ?? 0,
    });
  }
  return parseJsonLoose(firstText(res));
}

export const anthropicClient: LlmClient = {
  name: () => `anthropic/${config.anthropicModel}`,
  async structured(req) {
    try {
      return await complete(req, true);
    } catch (e) {
      // Если SDK/модель не знает output_config — фолбэк на схему текстом
      const msg = e instanceof Error ? e.message : String(e);
      if (/output_config|format/i.test(msg)) return complete(req, false);
      if (e instanceof Anthropic.APIError) {
        if (e.status === 401) throw new Error('Anthropic не принял ключ (401)');
        if (e.status === 429) throw new Error('Лимит Anthropic (429) — повтори позже');
      }
      throw e;
    }
  },
};
