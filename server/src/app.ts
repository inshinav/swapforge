// Сборка Fastify-приложения без listen/статики — общая для main() и тестов
// (тесты гоняют app.inject() против реальных роутов с реальной auth-цепочкой).
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { config } from './config';
import { attachAuth, requireApiAuth } from './auth/middleware';
import { registerRoutes } from './routes';
import { trustNginxProxy } from './proxy';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? true,
    bodyLimit: 1024 * 1024, // JSON-роуты; файлы идут через multipart со своими лимитами
    // Порт слушает loopback. Доверяем X-Forwarded-For только от локального nginx;
    // прямой клиент не может назначить себе произвольный IP заголовком.
    trustProxy: trustNginxProxy,
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.maxVideoBytes,
      files: 1,
      fields: 10,
    },
  });

  // Аутентификация на каждом запросе + default-deny для /api/* (см. middleware.ts)
  app.addHook('onRequest', attachAuth);
  app.addHook('preHandler', requireApiAuth);

  await registerRoutes(app);
  return app;
}
