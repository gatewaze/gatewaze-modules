/**
 * editor-ai-copilot — env-driven runtime configuration.
 *
 * Per spec-canvas-ai-copilot.md §3.2 / §4.3 / §10.
 *
 * Read once at import time; bad values fall back to defaults with a
 * single console.warn (pattern matches sites/api/canvas/canvas-config.ts).
 */

function readPositiveInt(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    // eslint-disable-next-line no-console
    console.warn(`[editor-ai-copilot] env ${name}='${raw}' invalid in [${min}, ${max}] — using ${fallback}`);
    return fallback;
  }
  return n;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  // eslint-disable-next-line no-console
  console.warn(`[editor-ai-copilot] env ${name}='${raw}' not boolean — using ${fallback}`);
  return fallback;
}

function readProvider(name: string, fallback: 'anthropic' | 'openai' | 'auto'): 'anthropic' | 'openai' | 'auto' {
  const raw = process.env[name];
  if (raw === 'anthropic' || raw === 'openai' || raw === 'auto') return raw;
  if (raw !== undefined && raw !== '') {
    // eslint-disable-next-line no-console
    console.warn(`[editor-ai-copilot] env ${name}='${raw}' invalid — using ${fallback}`);
  }
  return fallback;
}

/**
 * Anthropic models that support the `web_search_20250305` server-side
 * tool, per the spec-ai-chatbot-web-search requirements. Models that
 * don't support web_search are deliberately excluded: enabling the
 * tool on them produces an Anthropic 400 ("model does not support
 * tool"), which is a footgun.
 *
 * The list maps the model id to a short label. The label is for any
 * UI surface (admin model picker) that wants a human-readable name.
 * Order is the recommended pick order: Sonnet 4.5 first (best
 * balance), then descending capability/cost.
 */
export const ANTHROPIC_WEB_SEARCH_MODELS = [
  { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5 (recommended)' },
  { id: 'claude-sonnet-4-20250514',  label: 'Claude Sonnet 4' },
  { id: 'claude-opus-4-1-20250805',   label: 'Claude Opus 4.1' },
  { id: 'claude-opus-4-20250514',     label: 'Claude Opus 4' },
  { id: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5 (cheapest)' },
] as const;

export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

const ALLOWED_ANTHROPIC_MODEL_IDS: Set<string> = new Set(ANTHROPIC_WEB_SEARCH_MODELS.map((m) => m.id));

export function isSupportedAnthropicModel(modelId: string): boolean {
  return ALLOWED_ANTHROPIC_MODEL_IDS.has(modelId);
}

function readAnthropicModel(): string {
  const raw = process.env.SITES_CANVAS_AI_ANTHROPIC_MODEL;
  if (!raw) return ANTHROPIC_DEFAULT_MODEL;
  if (isSupportedAnthropicModel(raw)) return raw;
  // eslint-disable-next-line no-console
  console.warn(
    `[editor-ai-copilot] SITES_CANVAS_AI_ANTHROPIC_MODEL='${raw}' is not in the allow-list ` +
      `(does not support web_search_20250305). Falling back to ${ANTHROPIC_DEFAULT_MODEL}. ` +
      `Supported: ${ANTHROPIC_WEB_SEARCH_MODELS.map((m) => m.id).join(', ')}`,
  );
  return ANTHROPIC_DEFAULT_MODEL;
}

const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);

export const canvasAiConfig = {
  /** Feature kill switch. Defaults true if any provider key is set. */
  enabled: readBool('SITES_CANVAS_AI_ENABLED', hasAnthropic || hasOpenAi),

  /** Provider preference. 'auto' = anthropic if available, else openai. */
  provider: readProvider('SITES_CANVAS_AI_PROVIDER', 'auto'),

  /**
   * Anthropic model. Restricted to models that support the
   * `web_search_20250305` server-side tool (see
   * ANTHROPIC_WEB_SEARCH_MODELS above). Configured via
   * SITES_CANVAS_AI_ANTHROPIC_MODEL; unsupported values fall back
   * to the default with a console warning.
   */
  anthropicModel: readAnthropicModel(),

  /** OpenAI model — gpt-4o-mini default. */
  openaiModel: process.env.SITES_CANVAS_AI_OPENAI_MODEL ?? 'gpt-4o-mini',

  /** Provider keys (presence checked at request time). */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',

  /** Rate limits (§4.3). */
  perUserPerMin: readPositiveInt('SITES_CANVAS_AI_PER_USER_PER_MIN', 10, 1, 1000),
  perSitePerMin: readPositiveInt('SITES_CANVAS_AI_PER_SITE_PER_MIN', 30, 1, 5000),
  perUserPerDay: readPositiveInt('SITES_CANVAS_AI_PER_USER_PER_DAY', 100, 1, 100000),

  /** Prompt + output budgets (§6.2 / §6.5). */
  maxPromptChars: readPositiveInt('SITES_CANVAS_AI_MAX_PROMPT_CHARS', 2000, 1, 20000),
  maxBlocks: readPositiveInt('SITES_CANVAS_AI_MAX_BLOCKS', 30, 1, 200),
  maxFieldChars: readPositiveInt('SITES_CANVAS_AI_MAX_FIELD_CHARS', 5000, 100, 100000),
  maxOutputTokens: readPositiveInt('SITES_CANVAS_AI_MAX_OUTPUT_TOKENS', 4096, 256, 16384),
  toolSchemaBytesCap: readPositiveInt('SITES_CANVAS_AI_TOOL_SCHEMA_BYTES_CAP', 24 * 1024, 4096, 64 * 1024),

  /** Wall-clock timeout for the LLM call (§4.2 → 504 `ai_timeout`). */
  providerTimeoutMs: readPositiveInt('SITES_CANVAS_AI_PROVIDER_TIMEOUT_MS', 30_000, 5_000, 300_000),

  /**
   * Wall-clock timeout for the web-tools conversational loop. The loop
   * does multiple Anthropic round-trips (search + tool_result + final
   * compose), so 30s is too tight. Per spec-ai-chatbot-web-search §7
   * the worst-case turn is ≤ 60s; 120s is a safe default that allows
   * for upstream slowness.
   */
  webToolsTimeoutMs: readPositiveInt('SITES_CANVAS_AI_WEB_TOOLS_TIMEOUT_MS', 120_000, 30_000, 300_000),

  // ----- Phase F (Documents) -----

  /** Max documents per generate request (§4.1 doc_ids[]). */
  maxDocsPerRequest: readPositiveInt('SITES_CANVAS_AI_MAX_DOCS_PER_REQUEST', 5, 1, 20),

  /** Combined extracted-text token budget across all referenced docs. */
  maxCombinedDocTokens: readPositiveInt('SITES_CANVAS_AI_MAX_COMBINED_DOC_TOKENS', 50_000, 1_000, 200_000),

  /** Max bytes of stored extracted text per document (200 KB chars). */
  maxDocChars: readPositiveInt('SITES_CANVAS_AI_MAX_DOC_CHARS', 200_000, 1_000, 2_000_000),

  /** Upload file size hard ceiling. */
  maxDocUploadBytes: readPositiveInt('SITES_CANVAS_AI_MAX_DOC_UPLOAD_BYTES', 10 * 1024 * 1024, 1024, 100 * 1024 * 1024),

  /** URL-fetch budgets (§0000000a SSRF protections). */
  urlFetchTimeoutMs: readPositiveInt('SITES_CANVAS_AI_URL_FETCH_TIMEOUT_MS', 10_000, 1_000, 60_000),
  urlFetchMaxRedirects: readPositiveInt('SITES_CANVAS_AI_URL_FETCH_MAX_REDIRECTS', 3, 0, 10),

  /** Document-upload quota per user per hour. */
  docsPerUserPerHour: readPositiveInt('SITES_CANVAS_AI_DOCS_PER_USER_PER_HOUR', 30, 1, 1000),

  /** Document TTL — set on canvas_ai_documents.expires_at at insert. */
  docTtlMs: readPositiveInt('SITES_CANVAS_AI_DOC_TTL_MS', 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),

  // ----- AI Skills (git-driven prompt extensions) -----

  /** Master killswitch — when false, /generate skips skill loading and the cron skips enqueueing. */
  skillsEnabled: process.env.SITES_CANVAS_AI_SKILLS_ENABLED !== 'false',

  /** Total combined skill body bytes per generation. Excess truncates in priority order. */
  maxSkillsBytes: readPositiveInt('SITES_CANVAS_AI_MAX_SKILLS_BYTES', 32_768, 4_096, 131_072),

  /** Per-file size cap during sync. Files larger are skipped with a warning. */
  skillBodyMaxBytes: readPositiveInt('SITES_CANVAS_AI_SKILL_BODY_MAX_BYTES', 102_400, 1_024, 1_048_576),

  /** Soft cap on files indexed from a single repo. */
  maxSkillsPerSource: readPositiveInt('SITES_CANVAS_AI_MAX_SKILLS_PER_SOURCE', 500, 1, 5000),

  /** Wall-clock cap on a full source sync (aggregate). Per-step cap is this / 4. */
  skillSyncTimeoutMs: readPositiveInt('SITES_CANVAS_AI_SKILL_SYNC_TIMEOUT_MS', 120_000, 10_000, 600_000),

  /** Webhook calls per minute per source before 429. */
  skillWebhookRateMax: readPositiveInt('SITES_CANVAS_AI_WEBHOOK_RATE_MAX', 30, 1, 600),

  /** TTL for ai_skill_source_webhook_log rows. Swept by the existing 15-min cron. */
  skillWebhookLogRetentionDays: readPositiveInt('SITES_CANVAS_AI_WEBHOOK_LOG_RETENTION_DAYS', 30, 1, 365),

  /** Filesystem root for skill source clones. */
  skillCacheRoot: process.env.SITES_CANVAS_AI_SKILL_CACHE_ROOT ?? '/var/gatewaze/skills',

  // ----- AI chatbot web tools (web_search + fetch_url) -----
  // Spec: gatewaze-environments/specs/spec-ai-chatbot-web-search.md.
  // Platform is single-tenant per deployment, so these are env-driven
  // settings, not DB columns. Both default off — opt-in per deployment.

  /** Global kill switch. When 1/true, both tools are stripped from every tools array on the next request. */
  webToolsKillSwitch: readBool('AI_CHATBOT_TOOLS_KILL_SWITCH', false),

  /** Anthropic-hosted web_search enabled? Defaults false (opt-in). */
  webSearchEnabled: readBool('SITES_CANVAS_AI_WEB_SEARCH_ENABLED', false),
  /** Per-turn server-side cap (passed to Anthropic as max_uses). */
  webSearchMaxPerTurn: readPositiveInt('SITES_CANVAS_AI_WEB_SEARCH_MAX_PER_TURN', 3, 1, 20),
  /** Daily cap on web_search calls. Tool stripped after this is reached. 0 = unlimited. */
  webSearchDailyMax: readPositiveInt('SITES_CANVAS_AI_WEB_SEARCH_DAILY_MAX', 1000, 0, 1_000_000),

  /** Our fetch_url client-side tool enabled? Defaults false (opt-in). */
  fetchUrlEnabled: readBool('SITES_CANVAS_AI_FETCH_URL_ENABLED', false),
  /** Per-turn cap on fetch_url invocations (enforced in our handler). */
  fetchUrlMaxPerTurn: readPositiveInt('SITES_CANVAS_AI_FETCH_URL_MAX_PER_TURN', 3, 1, 20),
  /** Daily cap on fetch_url calls. Tool stripped after this is reached. 0 = unlimited. */
  fetchUrlDailyMax: readPositiveInt('SITES_CANVAS_AI_FETCH_URL_DAILY_MAX', 5000, 0, 1_000_000),
  /** Hard byte cap on a single fetch_url response body returned to the model. */
  fetchUrlMaxBytes: readPositiveInt('SITES_CANVAS_AI_FETCH_URL_MAX_BYTES', 1_048_576, 1024, 10_485_760),
  /** Wall-clock cap on a single fetch_url upstream call. */
  fetchUrlTimeoutMs: readPositiveInt('SITES_CANVAS_AI_FETCH_URL_TIMEOUT_MS', 15_000, 1_000, 60_000),

  /** Daily cost budget (USD micros — 1c = 10_000). null = no cap. Set via the *_DAILY_COST_BUDGET_CENTS env var, which we convert. */
  dailyToolCostBudgetMicroUsd: (() => {
    const raw = process.env.SITES_CANVAS_AI_DAILY_TOOL_COST_BUDGET_CENTS;
    if (!raw) return null;
    const cents = Number(raw);
    if (!Number.isFinite(cents) || cents <= 0) return null;
    return Math.round(cents * 10_000); // cents → micro-USD
  })(),

  /** Per-call cost estimates. Used for the cost-budget pre-call gate. */
  webSearchCostMicroUsd: readPositiveInt('SITES_CANVAS_AI_WEB_SEARCH_COST_MICRO_USD', 10_000, 0, 1_000_000), // 1c default
  fetchUrlCostMicroUsd: readPositiveInt('SITES_CANVAS_AI_FETCH_URL_COST_MICRO_USD', 5_000, 0, 1_000_000), // 0.5c default — adjust per gatewaze-fetch rate card

  /**
   * fetch_url backend selection (spec §3.2 / spec-gatewaze-fetch §2.5):
   *
   *   - **Internal** (default when SCRAPLING_FETCHER_URL is set): the
   *     editor-ai-copilot runs inside the same cluster as scrapling-
   *     fetcher. Going direct keeps traffic in-cluster, avoids per-tenant
   *     API key rotation, and bypasses gatewaze-fetch's billing ledger
   *     (which exists for external callers). This is the path scraper
   *     workers already use today.
   *
   *   - **External** (fallback when GATEWAZE_FETCH_API_KEY is set):
   *     editor-ai-copilot runs outside the cluster — goes through the
   *     gatewaze-fetch publicApi with a per-tenant Bearer key.
   *
   * Internal wins if both are configured.
   */
  scraplingFetcherUrl: process.env.SCRAPLING_FETCHER_URL ?? '',
  scraplingInternalToken: process.env.SCRAPLING_INTERNAL_TOKEN ?? '',
  /** scrapling-fetcher mode: fast | stealth | browser. Default 'fast'. */
  scraplingFetcherMode: (() => {
    const raw = process.env.SITES_CANVAS_AI_SCRAPLING_MODE;
    return raw === 'stealth' || raw === 'browser' ? raw : ('fast' as const);
  })() as 'fast' | 'stealth' | 'browser',

  /** gatewaze-fetch service base URL (external mode only). */
  gatewazeFetchBaseUrl: process.env.GATEWAZE_FETCH_BASE_URL ?? '',
  /** gatewaze-fetch API key (Bearer; external mode only). */
  gatewazeFetchApiKey: process.env.GATEWAZE_FETCH_API_KEY ?? '',
  /** Tenant identifier for X-Gatewaze-Tenant (external mode only). */
  gatewazeFetchTenantId: process.env.GATEWAZE_FETCH_TENANT_ID ?? 'default',
} as const;

export type CanvasAiConfig = typeof canvasAiConfig;

/**
 * Has at least one provider key set + feature enabled. Used by the
 * route handlers (503 if not) and by the admin feature-flags endpoint
 * (hides the sidebar pane).
 */
export function isCanvasAiUsable(): boolean {
  return canvasAiConfig.enabled && Boolean(canvasAiConfig.anthropicApiKey || canvasAiConfig.openaiApiKey);
}
