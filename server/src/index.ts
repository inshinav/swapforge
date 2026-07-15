import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config';
import { getDb, resetInterruptedJobs } from './db';
import { registerRoutes } from './routes';
import { enforceStorageCap, sweepOrphanRefFiles } from './storage';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  fs.mkdirSync(config.dataDir, { recursive: true });
  getDb();
  resetInterruptedJobs();
  const swept = sweepOrphanRefFiles();
  if (swept) console.log(`[sweep] удалено файлов-сирот от оборванных загрузок: ${swept}`);
  const { purged } = enforceStorageCap();
  if (purged.length) console.log(`[rotation] на старте очищены исходники: ${purged.join(', ')}`);

  const app = Fastify({
    logger: true,
    bodyLimit: 1024 * 1024, // JSON-роуты; файлы идут через multipart со своими лимитами
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.maxVideoBytes,
      files: 1,
      fields: 10,
    },
  });

  await registerRoutes(app);

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
