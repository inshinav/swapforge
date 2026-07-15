import type { FastifyInstance } from 'fastify';
import { config, llmKeyPresent, llmModelName } from './config';
import { ffmpegAvailable } from './ffmpeg';
import { dataUsageBytes } from './storage';
import type { HealthInfo } from '../../shared/api-types';

let ffmpegOk: boolean | null = null;

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (): Promise<HealthInfo> => {
    if (ffmpegOk === null) ffmpegOk = await ffmpegAvailable();
    const dataBytes = dataUsageBytes();
    return {
      ok: true,
      version: config.version,
      provider: config.llmProvider,
      model: llmModelName(),
      keyPresent: llmKeyPresent(),
      ffmpeg: ffmpegOk,
      dataBytes,
      storageCapBytes: config.storageCapBytes,
      diskUsedPct: Math.round((dataBytes / config.storageCapBytes) * 100),
    };
  });
}
