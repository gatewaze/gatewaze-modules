/**
 * Lazy ioredis client factory shared by the API process (XREAD,
 * XINFO, PUBLISH) and worker process (XADD, SUBSCRIBE, INCR).
 *
 * `ioredis` is a peer of the host platform — at module-package dev
 * time it may not be installed, and at runtime the AI module is
 * consumed *through* the API package's node_modules. We resolve via
 * `createRequire` against the API package the same way `inspector.ts`
 * resolves `bullmq`, so the platform's existing ioredis install is
 * picked up reliably.
 *
 * Spec: spec-ai-job-runner §7.1.
 */

import { createRequire } from 'node:module';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisLike = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisCtor = new (...args: any[]) => RedisLike;

let sharedClient: RedisLike | null = null;
let sharedSubscriber: RedisLike | null = null;
let cachedCtor: RedisCtor | null = null;
let lastConnectError: Error | null = null;
let configuredProjectRoot: string | null = null;

/**
 * Prime the module-level project root so loadRedisCtor() can resolve
 * `ioredis` through the API package's module graph even before any
 * request hits a route handler. The platform's apiRoutes(ctx) callback
 * calls this from register-routes.ts at startup.
 */
export function setProjectRoot(root: string): void {
  configuredProjectRoot = root;
}

/**
 * Resolve the ioredis ctor through the host project's module graph.
 * Tries setProjectRoot()'s value first, then env, then cwd.
 */
function loadRedisCtor(): RedisCtor {
  if (cachedCtor) return cachedCtor;
  const candidates: string[] = [];
  if (configuredProjectRoot) {
    candidates.push(`${configuredProjectRoot}/packages/api/package.json`);
  }
  const envRoot = process.env.GATEWAZE_PROJECT_ROOT;
  if (envRoot) candidates.push(`${envRoot}/packages/api/package.json`);
  candidates.push(`${process.cwd()}/packages/api/package.json`);
  // Final fallback — plain dynamic require (works in monorepo dev where
  // ioredis hoists to the workspace root, OR when the cwd IS the api package).
  candidates.push(`${process.cwd()}/package.json`);

  let lastError: unknown;
  for (const c of candidates) {
    try {
      const req = createRequire(c);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = req('ioredis') as { default?: RedisCtor } & RedisCtor;
      cachedCtor = (mod.default ?? mod) as RedisCtor;
      return cachedCtor!;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `ioredis not resolvable from any of: ${candidates.join(', ')}; last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function buildConnectionUrl(): string | null {
  // Matches gatewaze/packages/api/src/lib/queue/connection.ts so the
  // module + the platform connect to the SAME Redis.
  if (process.env.REDIS_URL && process.env.REDIS_URL.length > 0) {
    return process.env.REDIS_URL;
  }
  if (process.env.REDIS_HOST) {
    const port = process.env.REDIS_PORT ?? '6379';
    const pass = process.env.REDIS_PASSWORD
      ? `:${encodeURIComponent(process.env.REDIS_PASSWORD)}@`
      : '';
    return `redis://${pass}${process.env.REDIS_HOST}:${port}`;
  }
  return null;
}

function baseConnectionOptions(): Record<string, unknown> {
  return {
    // Match the platform's queue/connection.ts so blocking commands
    // (XREAD BLOCK, BRPOP) work.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  };
}

function buildClient(): RedisLike {
  const Ctor = loadRedisCtor();
  const url = buildConnectionUrl();
  if (!url) {
    throw new Error(
      'Redis is not configured — set REDIS_URL or REDIS_HOST so the AI job runner can dispatch jobs.',
    );
  }
  // ioredis: `new Redis(url, options)` mirrors the platform's own
  // queue/connection.ts. baseConnectionOptions() also disables
  // maxRetriesPerRequest so blocking commands work.
  return new Ctor(url, baseConnectionOptions());
}

/**
 * Return the shared client used for non-blocking commands (XADD, XINFO,
 * SCAN, INCR, EXPIRE, PUBLISH). Safe to reuse across the process.
 */
export async function getRedisClient(): Promise<RedisLike> {
  if (sharedClient) return sharedClient;
  sharedClient = buildClient();
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
  sharedSubscriber = buildClient();
  return sharedSubscriber!;
}

/**
 * Create a NEW dedicated client. Use when the caller needs an isolated
 * connection (e.g. SSE bridge XREAD BLOCK ties up the connection so
 * we don't want to share with the rest of the API).
 */
export async function createDedicatedRedisClient(): Promise<RedisLike> {
  return buildClient();
}

/** Quick liveness check — used by the API to 503 when Redis is down. */
export async function pingRedis(): Promise<boolean> {
  try {
    const c = await getRedisClient();
    const r = (await c.ping()) as string;
    lastConnectError = null;
    return r === 'PONG';
  } catch (err) {
    lastConnectError = err instanceof Error ? err : new Error(String(err));
    return false;
  }
}

/** Last error captured by pingRedis(); surface in 503 responses. */
export function getLastConnectError(): string | null {
  return lastConnectError?.message ?? null;
}

/** Test-only: reset cached clients so each test gets a fresh setup. */
export function __resetForTests(): void {
  sharedClient = null;
  sharedSubscriber = null;
}
