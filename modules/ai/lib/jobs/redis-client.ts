/**
 * Lazy ioredis client factory shared by the API process (XREAD,
 * XINFO, PUBLISH) and worker process (XADD, SUBSCRIBE, INCR).
 *
 * We hand-roll this here rather than depending on the platform's API
 * package because @gatewaze-modules/ai is consumable as a standalone
 * module. The connection is resolved from REDIS_URL or
 * REDIS_HOST/REDIS_PORT/REDIS_PASSWORD env (mirrors the platform's
 * convention).
 *
 * Spec: spec-ai-job-runner §7.1.
 */

// `ioredis` is a peer of the platform — when the module runs inside
// the API process the constructor is already loaded. We `import()`
// lazily so unit tests can mock it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisLike = any;

let sharedClient: RedisLike | null = null;
let sharedSubscriber: RedisLike | null = null;

async function loadRedisCtor(): Promise<new (...args: unknown[]) => RedisLike> {
  // Dynamic import keeps ioredis off the import graph for module
  // consumers that don't actually exercise the job-runner code.
  // ioredis is a peer dep — at module-package dev time it may not be
  // installed; runtime resolution happens through the host project's
  // node_modules. We use a dynamic specifier so TypeScript doesn't
  // require the type declaration at this package's build time.
  const specifier = 'ioredis';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import(/* @vite-ignore */ specifier)) as any;
  return (mod.default ?? mod) as new (...args: unknown[]) => RedisLike;
}

function buildConnectionOptions(): Record<string, unknown> {
  const url = process.env.REDIS_URL;
  if (url && url.length > 0) {
    // ioredis accepts a URL string directly as first arg, but we keep
    // an options-object path for the host/port fallback too.
    return { url };
  }
  return {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    // BullMQ requires this so blocking commands work.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

/**
 * Return the shared client used for non-blocking commands (XADD, XINFO,
 * SCAN, INCR, EXPIRE, PUBLISH). Safe to reuse across the process.
 */
export async function getRedisClient(): Promise<RedisLike> {
  if (sharedClient) return sharedClient;
  const Ctor = await loadRedisCtor();
  const opts = buildConnectionOptions();
  if ('url' in opts && typeof opts.url === 'string') {
    sharedClient = new Ctor(opts.url);
  } else {
    sharedClient = new Ctor(opts);
  }
  return sharedClient!;
}

/**
 * Return a dedicated subscriber client. ioredis requires a separate
 * connection for SUBSCRIBE because the client switches into pub/sub
 * mode and can no longer issue regular commands. Subscribers are
 * created on demand and cached.
 */
export async function getRedisSubscriber(): Promise<RedisLike> {
  if (sharedSubscriber) return sharedSubscriber;
  const Ctor = await loadRedisCtor();
  const opts = buildConnectionOptions();
  if ('url' in opts && typeof opts.url === 'string') {
    sharedSubscriber = new Ctor(opts.url);
  } else {
    sharedSubscriber = new Ctor(opts);
  }
  return sharedSubscriber!;
}

/**
 * Create a NEW dedicated client. Use when the caller needs an isolated
 * connection (e.g. SSE bridge XREAD BLOCK ties up the connection so
 * we don't want to share with the rest of the API).
 */
export async function createDedicatedRedisClient(): Promise<RedisLike> {
  const Ctor = await loadRedisCtor();
  const opts = buildConnectionOptions();
  if ('url' in opts && typeof opts.url === 'string') {
    return new Ctor(opts.url);
  }
  return new Ctor(opts);
}

/** Quick liveness check — used by the API to 503 when Redis is down. */
export async function pingRedis(): Promise<boolean> {
  try {
    const c = await getRedisClient();
    const r = (await c.ping()) as string;
    return r === 'PONG';
  } catch {
    return false;
  }
}

/** Test-only: reset cached clients so each test gets a fresh setup. */
export function __resetForTests(): void {
  sharedClient = null;
  sharedSubscriber = null;
}
