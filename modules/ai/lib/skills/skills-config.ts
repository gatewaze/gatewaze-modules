/**
 * Env-driven runtime configuration for the skill sync worker.
 *
 * Historically these knobs lived in editor-ai-copilot's `canvas-ai-config.ts`
 * under `SITES_CANVAS_AI_SKILL_*` env vars. Now that skills are owned by the
 * ai module, the same env vars are read here — we keep the names to avoid
 * breaking any existing operator config; ops can rename to `AI_SKILL_*`
 * in a future cleanup.
 *
 * Read once at import time; bad values fall back to defaults with a single
 * console.warn (same pattern as the prior canvas-ai-config).
 */

function readPositiveInt(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    // eslint-disable-next-line no-console
    console.warn(`[ai-skills] env ${name}='${raw}' invalid in [${min}, ${max}] — using ${fallback}`);
    return fallback;
  }
  return n;
}

export const skillsConfig = {
  /** Kill-switch: set SITES_CANVAS_AI_SKILLS_ENABLED=false to disable sync end-to-end. */
  skillsEnabled: process.env.SITES_CANVAS_AI_SKILLS_ENABLED !== 'false',
  /** Per-file body cap. Larger .md files are skipped at sync time. */
  skillBodyMaxBytes: readPositiveInt('SITES_CANVAS_AI_SKILL_BODY_MAX_BYTES', 102_400, 1_024, 1_048_576),
  /** Per-source file count cap. Walk stops once this many .md files are indexed. */
  maxSkillsPerSource: readPositiveInt('SITES_CANVAS_AI_MAX_SKILLS_PER_SOURCE', 500, 1, 5000),
  /** Overall budget for a single source sync. */
  skillSyncTimeoutMs: readPositiveInt('SITES_CANVAS_AI_SKILL_SYNC_TIMEOUT_MS', 120_000, 10_000, 600_000),
  /** Per-source webhook rate cap (req/min) — defends against runaway CI loops. */
  skillWebhookRateMax: readPositiveInt('SITES_CANVAS_AI_WEBHOOK_RATE_MAX', 30, 1, 600),
  /** On-disk cache root where source repos are cloned. One subdir per source. */
  skillCacheRoot: process.env.SITES_CANVAS_AI_SKILL_CACHE_ROOT ?? '/var/gatewaze/skills',
} as const;
