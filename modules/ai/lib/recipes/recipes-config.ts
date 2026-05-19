/**
 * Env-driven runtime configuration for the recipe sync worker.
 *
 * Mirrors lib/skills/skills-config.ts. Knob names follow `AI_RECIPE_*`
 * since recipes are a new surface (no legacy operator config to
 * preserve). The kill-switch shares a name pattern with skills so
 * operators can disable both via familiar tooling.
 */

function readPositiveInt(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    // eslint-disable-next-line no-console
    console.warn(`[ai-recipes] env ${name}='${raw}' invalid in [${min}, ${max}] — using ${fallback}`);
    return fallback;
  }
  return n;
}

export const recipesConfig = {
  /** Kill-switch: set AI_RECIPES_ENABLED=false to disable sync + execution end-to-end. */
  recipesEnabled: process.env.AI_RECIPES_ENABLED !== 'false',
  /** Per-file body cap. Larger recipe YAMLs are skipped at sync time. */
  recipeBodyMaxBytes: readPositiveInt('AI_RECIPE_BODY_MAX_BYTES', 102_400, 1_024, 1_048_576),
  /** Per-source recipe count cap. */
  maxRecipesPerSource: readPositiveInt('AI_MAX_RECIPES_PER_SOURCE', 200, 1, 5000),
  /** Overall budget for a single source sync. */
  recipeSyncTimeoutMs: readPositiveInt('AI_RECIPE_SYNC_TIMEOUT_MS', 120_000, 10_000, 600_000),
  /** Per-source webhook rate cap (req/min). */
  recipeWebhookRateMax: readPositiveInt('AI_RECIPE_WEBHOOK_RATE_MAX', 30, 1, 600),
  /**
   * On-disk cache root where recipe source repos are cloned. We use a
   * separate root from skills so operators can mount different volumes
   * or apply different quotas — and so a runaway recipe-source clone
   * can't impact skill availability.
   */
  recipeCacheRoot: process.env.AI_RECIPE_CACHE_ROOT ?? '/var/gatewaze/recipes',
} as const;
