// Общий харнесс роут-тестов: реальное приложение (buildApp) + залогиненный юзер.
// app.inject оборачивается так, что auth-заголовки подмешиваются автоматически —
// legacy-тесты зовут inject как раньше, но проходят реальную auth-цепочку.
// Требование: тест-файл ставит process.env.AUTH_DEV_BYPASS = '1' ДО импортов src.
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app';
import { getDb } from '../src/db';

export interface AuthedApp {
  app: FastifyInstance;
  userId: string;
  headers: { cookie: string; 'x-sf-csrf': string };
  /** Приписать созданный напрямую в БД проект сессионному юзеру. */
  own: (projectId: string) => void;
}

export async function makeAuthedApp(telegramId = 4242, name = 'Тест-Юзер'): Promise<AuthedApp> {
  const app = await buildApp({ logger: false });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/dev-login',
    payload: { telegramId, name },
  });
  if (res.statusCode !== 200) {
    throw new Error(
      `dev-login не сработал (${res.statusCode}): забыт process.env.AUTH_DEV_BYPASS='1' до импортов?`,
    );
  }
  const setCookies = res.headers['set-cookie'] as string[];
  const sess = setCookies.find((c) => c.startsWith('sf_sess='))!.split(';')[0]!;
  const csrfPair = setCookies.find((c) => c.startsWith('sf_csrf='))!.split(';')[0]!;
  const csrf = decodeURIComponent(csrfPair.split('=').slice(1).join('='));
  const headers = { cookie: `${sess}; ${csrfPair}`, 'x-sf-csrf': csrf };
  const userId = (res.json() as { user: { id: string } }).user.id;

  const rawInject = app.inject.bind(app) as (o: InjectOptions) => Promise<{ statusCode: number }>;
  (app as unknown as { inject: typeof rawInject }).inject = (o: InjectOptions) =>
    rawInject({
      ...o,
      headers: { ...headers, ...((o.headers as Record<string, string>) ?? {}) },
    });

  return {
    app,
    userId,
    headers,
    own: (projectId: string) => {
      getDb().prepare(`UPDATE projects SET user_id = ? WHERE id = ?`).run(userId, projectId);
    },
  };
}
