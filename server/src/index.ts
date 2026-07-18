import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertAuthConfig, config } from './config';
import { getDb, resetInterruptedJobs } from './db';
import { buildApp } from './app';
import { warmPricing } from './pricing';
import { resumeGenerations } from './engine/render';
import { enforceStorageCap, sweepOrphanRefFiles } from './storage';
import { purgeExpiredSessions } from './auth/sessions';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  assertAuthConfig(); // prod без auth-env не поднимается — молчаливый фолбэк = открытая дверь
  fs.mkdirSync(config.dataDir, { recursive: true });
  getDb();
  resetInterruptedJobs();
  const purgedSessions = purgeExpiredSessions();
  if (purgedSessions) console.log(`[auth] удалено протухших сессий: ${purgedSessions}`);
  setInterval(() => purgeExpiredSessions(), 24 * 3_600_000).unref();
  // Рендеры переживают рестарт: submitted/rendering/downloading снова поллятся,
  // прерванные аплоады помечаются failed (ретрай дёшев — URL переиспользуются)
  resumeGenerations();
  const swept = sweepOrphanRefFiles();
  if (swept) console.log(`[sweep] удалено файлов-сирот от оборванных загрузок: ${swept}`);
  const { purged } = enforceStorageCap();
  if (purged.length) console.log(`[rotation] на старте очищены исходники: ${purged.join(', ')}`);
  // Прогрев живых тарифов (litellm + каталог WaveSpeed + баланс) — не блокирует старт
  void warmPricing().catch((e) =>
    console.warn(`[pricing] прогрев не удался: ${e instanceof Error ? e.message : e}`),
  );

  const app = await buildApp();

  // Статика фронта (prod): web/dist рядом с server/dist
  const webDist = config.webDist || path.resolve(here, '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      index: ['index.html'],
      setHeaders: (res, filePath) => {
        // index.html не кэшируем — иначе после деплоя браузер держит старый билд;
        // ассеты хэшированы vite'ом, им можно вечный кэш
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.log.warn(`web dist не найден (${webDist}) — фронт не раздаётся`);
  }

  await app.listen({ port: config.port, host: config.host });
}

main().catch((e) => {
  console.error('Фатальная ошибка старта:', e);
  process.exit(1);
});
