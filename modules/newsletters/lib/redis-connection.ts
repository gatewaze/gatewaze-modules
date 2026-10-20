/**
 * BullMQ connection options from the environment, the way the scrapers
 * module builds them (REDIS_URL, else REDIS_HOST / REDIS_PORT). Modules
 * cannot import @gatewaze/shared/redis at runtime: the api image resolves
 * @gatewaze/shared from packages/api/node_modules, which has no redis entry.
 */
export function redisConnection(): { host: string; port: number; password?: string; maxRetriesPerRequest: null } {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const url = new URL(redisUrl);
      return { host: url.hostname, port: parseInt(url.port || '6379', 10), password: url.password || undefined, maxRetriesPerRequest: null };
    } catch {
      // fall through to host/port
    }
  }
  return { host: process.env.REDIS_HOST || 'redis', port: parseInt(process.env.REDIS_PORT || '6379', 10), password: process.env.REDIS_PASSWORD || undefined, maxRetriesPerRequest: null };
}
