// In-memory sliding-window лимитер (порт паттерна ai-dash на Fastify preHandler).
// У КАЖДОГО лимитера свой Map — общий стор когда-то ронял чужие бюджеты. Ключи с
// полностью протухшими таймстампами сметаются интервалом (спуф X-Forwarded-For не
// раздует Map безгранично). Single-process инвариант нашего VPS — Redis не нужен.
import type { FastifyReply, FastifyRequest } from 'fastify';

export type RateKeyFn = (req: FastifyRequest) => string;

export const byIp: RateKeyFn = (req) => `ip:${req.ip || 'unknown'}`;

export function rateLimit(maxHits: number, windowMs: number, key: RateKeyFn = byIp) {
  const hits = new Map<string, number[]>();
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, times] of hits) if (times.every((t) => t <= cutoff)) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const k = key(req);
    const now = Date.now();
    const times = (hits.get(k) ?? []).filter((t) => now - t < windowMs);
    times.push(now);
    hits.set(k, times);
    if (times.length > maxHits) {
      return reply.code(429).send({ error: 'Слишком много запросов — попробуй чуть позже' });
    }
  };
}
