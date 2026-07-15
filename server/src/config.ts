import path from 'node:path';

const env = (k: string, def = ''): string => process.env[k]?.trim() || def;

export const config = {
  port: Number(env('PORT', '4315')),
  host: env('HOST', '127.0.0.1'),
  dataDir: path.resolve(env('DATA_DIR', path.join(process.cwd(), 'data'))),
  webDist: env('WEB_DIST', ''),
  llmProvider: env('LLM_PROVIDER', 'openai') as 'openai' | 'anthropic',
  openaiApiKey: env('OPENAI_API_KEY'),
  openaiModel: env('OPENAI_MODEL', 'gpt-5.5'),
  anthropicApiKey: env('ANTHROPIC_API_KEY'),
  anthropicModel: env('ANTHROPIC_MODEL', 'claude-sonnet-5'),
  openaiImageModel: env('OPENAI_MODEL_IMAGE', 'gpt-image-2'),
  imageQuality: env('IMAGE_QUALITY', 'high'),
  imageLongSide: Number(env('IMAGE_LONG_SIDE', '2048')),
  wavespeedApiKey: env('WAVESPEED_API_KEY'),
  // Эндпоинт Seedance зафиксирован решением Alex: именно 2.0, не fast
  seedanceEndpoint: 'bytedance/seedance-2.0/video-edit',
  storageCapBytes: Number(env('STORAGE_CAP_GB', '10')) * 1024 ** 3,
  maxVideoBytes: Number(env('MAX_VIDEO_MB', '300')) * 1024 ** 2,
  maxImageBytes: Number(env('MAX_IMAGE_MB', '20')) * 1024 ** 2,
  maxFrames: Number(env('MAX_FRAMES', '40')),
  version: '1.0.0',
};

export function llmKeyPresent(): boolean {
  return config.llmProvider === 'openai' ? !!config.openaiApiKey : !!config.anthropicApiKey;
}

export type LlmTask = 'analyze' | 'generate';

/**
 * Авто-роутинг моделей: сервис сам берёт оптимально дешёвую под задачу, при сбое модели
 * автоматически откатывается по цепочке (лог [llm-fallback]). Эмпирика 15.07.2026:
 * 5.6-terra — быстрый/дешёвый tier, 5.6-luna — топ; все 5.6 умеют vision + structured output.
 * - analyze: объём = input-токены ~30 кадров → дешёвый быстрый tier;
 * - generate: вход крошечный, качество промтов решает всё → топ-tier.
 * env OPENAI_MODEL_ANALYZE / OPENAI_MODEL_GENERATE ставит свою модель ПЕРВОЙ в цепочке.
 */
const DEFAULT_CHAINS: Record<LlmTask, string[]> = {
  analyze: ['gpt-5.6-terra', 'gpt-5.4-mini', 'gpt-5.5'],
  generate: ['gpt-5.6-luna', 'gpt-5.5'],
};

export function modelChainFor(task: LlmTask): string[] {
  if (config.llmProvider !== 'openai') {
    const override = env(`ANTHROPIC_MODEL_${task.toUpperCase()}`);
    return [override || config.anthropicModel];
  }
  const chain = [...DEFAULT_CHAINS[task]];
  const override = env(`OPENAI_MODEL_${task.toUpperCase()}`);
  if (override) {
    return [override, ...chain.filter((m) => m !== override)];
  }
  return chain;
}

export function llmModelName(): string {
  const a = modelChainFor('analyze')[0];
  const g = modelChainFor('generate')[0];
  return a === g ? (a as string) : `анализ ${a} · промты ${g}`;
}
