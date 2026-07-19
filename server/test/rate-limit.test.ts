import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { trustNginxProxy } from '../src/proxy';
import { byUserOrIp, rateLimit } from '../src/rateLimit';

async function buildLimitedApp() {
  const app = Fastify({ logger: false, trustProxy: trustNginxProxy });
  app.get('/limited', { preHandler: rateLimit(1, 60_000) }, async (req) => ({ ip: req.ip }));
  await app.ready();
  return app;
}

describe('rate-limit за локальным nginx', () => {
  it('разделяет посетителей по перезаписанному X-Forwarded-For', async () => {
    const app = await buildLimitedApp();
    try {
      const first = await app.inject({
        method: 'GET',
        url: '/limited',
        headers: { 'x-forwarded-for': '198.51.100.10' },
      });
      const second = await app.inject({
        method: 'GET',
        url: '/limited',
        headers: { 'x-forwarded-for': '198.51.100.11' },
      });
      const repeat = await app.inject({
        method: 'GET',
        url: '/limited',
        headers: { 'x-forwarded-for': '198.51.100.10' },
      });

      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ ip: '198.51.100.10' });
      expect(second.statusCode).toBe(200);
      expect(repeat.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('не доверяет X-Forwarded-For от прямого нелокального peer', async () => {
    const app = await buildLimitedApp();
    try {
      const first = await app.inject({
        method: 'GET',
        url: '/limited',
        remoteAddress: '203.0.113.50',
        headers: { 'x-forwarded-for': '198.51.100.20' },
      });
      const spoofedAgain = await app.inject({
        method: 'GET',
        url: '/limited',
        remoteAddress: '203.0.113.50',
        headers: { 'x-forwarded-for': '198.51.100.21' },
      });

      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ ip: '203.0.113.50' });
      expect(spoofedAgain.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('checkout может лимитироваться по пользователю, а не по общему NAT/IP', () => {
    const key = byUserOrIp({ user: { id: 'user-42' }, ip: '127.0.0.1' } as never);
    expect(key).toBe('user:user-42');
  });

  it('nginx перезаписывает, а не продолжает клиентскую цепочку IP', () => {
    const conf = readFileSync(new URL('../../deploy/nginx-swapforge.conf', import.meta.url), 'utf8');
    expect(conf).not.toContain('$proxy_add_x_forwarded_for');
    expect(conf.match(/proxy_set_header X-Forwarded-For \$remote_addr;/g)).toHaveLength(2);
  });
});
