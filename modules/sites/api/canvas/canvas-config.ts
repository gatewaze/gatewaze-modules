/**
 * Canvas runtime configuration. Per spec-sites-wysiwyg-builder §8 the
 * limits and TTLs that govern editor behaviour MUST be tunable per
 * deploy without a code change. This module reads the relevant env vars
 * once at import time and exposes typed constants. Every other canvas
 * module imports from here instead of declaring its own literal.
 *
 * Defaults match the values the spec ships with; bumping them is an
 * ops decision, never a code-review one.
 */

function readPositiveInt(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    // Bad value — log to stderr and use fallback. We don't throw here
    // because canvas runs inside the platform's express boot path and
    // a bad env var shouldn't take the whole server down.
    // eslint-disable-next-line no-console
    console.warn(`[sites] env var ${name}='${raw}' is not a valid integer in [${min}, ${max}] — using default ${fallback}`);
    return fallback;
  }
  return n;
}

function readEngine(name: string, fallback: 'legacy' | 'puck'): 'legacy' | 'puck' {
  const raw = process.env[name];
  if (raw === 'legacy' || raw === 'puck') return raw;
  if (raw !== undefined && raw !== '') {
    // eslint-disable-next-line no-console
    console.warn(`[sites] env var ${name}='${raw}' is not 'legacy' | 'puck' — using default ${fallback}`);
  }
  return fallback;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  // eslint-disable-next-line no-console
  console.warn(`[sites] env var ${name}='${raw}' is not boolean (true|false|1|0) — using default ${fallback}`);
  return fallback;
}

export const canvasConfig = {
  /** Editor advisory-lock TTL in seconds. Heartbeat must arrive within this. */
  lockTtlSeconds: readPositiveInt('CANVAS_LOCK_TTL_SECONDS', 90, 10, 3600),

  /** Maximum ops per applyOps envelope. Caps client-side coalescing. */
  opBatchMax: readPositiveInt('CANVAS_OP_BATCH_MAX', 100, 1, 1000),

  /**
   * Maximum total page_blocks for a single page. SQL-side cap enforced
   * by canvas_apply_ops; this constant mirrors the value sent in
   * p_max_blocks so the JS validator can short-circuit before RPC.
   */
  blockCountMax: readPositiveInt('CANVAS_BLOCK_COUNT_MAX', 200, 1, 5000),

  /** Idempotency cache lifetime in milliseconds. */
  idempotencyTtlMs: readPositiveInt('CANVAS_IDEMPOTENCY_TTL_MS', 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),

  /** block-defs cache TTL in milliseconds. Busted by templates_invalidate NOTIFY. */
  blockDefsCacheTtlMs: readPositiveInt('CANVAS_BLOCK_DEFS_CACHE_TTL_MS', 60_000, 1_000, 600_000),

  /**
   * Master kill switch — when false, every canvas endpoint returns 503
   * canvas.disabled. The admin UI gate also reads this via the
   * /api/admin/sites/:slug feature-flags endpoint (when present) or
   * falls back to assuming enabled if the platform doesn't expose it.
   */
  enabled: readBool('CANVAS_ENABLED', true),

  /**
   * Default canvas editor engine when a site has no explicit
   * `sites.settings.canvas.engine` value. Per
   * spec-builder-evaluation §3.7. 'legacy' | 'puck'.
   */
  engineDefault: readEngine('SITES_CANVAS_ENGINE_DEFAULT', 'legacy'),
} as const;

export type CanvasConfig = typeof canvasConfig;
