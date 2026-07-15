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
 * Модель под задачу: OPENAI_MODEL_ANALYZE / OPENAI_MODEL_GENERATE (или ANTHROPIC_MODEL_*)
 * перекрывают базовую OPENAI_MODEL / ANTHROPIC_MODEL. Анализ — vision-тяжёлый (почти весь
 * расход = input-токены кадров), генерация — короткая, но требует максимума интеллекта.
 */
export function modelForTask(task: LlmTask): string {
  const suffix = task === 'analyze' ? 'ANALYZE' : 'GENERATE';
  if (config.llmProvider === 'openai') {
    return env(`OPENAI_MODEL_${suffix}`) || config.openaiModel;
  }
  return env(`ANTHROPIC_MODEL_${suffix}`) || config.anthropicModel;
}

export function llmModelName(): string {
  const a = modelForTask('analyze');
  const g = modelForTask('generate');
  return a === g ? a : `анализ ${a} · промты ${g}`;
}
