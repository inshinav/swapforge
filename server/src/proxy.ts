/**
 * Fastify may accept X-Forwarded-For only from the nginx process on the same host.
 * `hop === 0` is the immediate TCP peer; forwarded addresses can never become
 * trusted proxies themselves, even if a client sends a crafted header chain.
 */
export function trustNginxProxy(address: string, hop: number): boolean {
  if (hop !== 0) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
