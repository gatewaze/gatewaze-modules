/**
 * Refresh the AI price book from LiteLLM's
 * `model_prices_and_context_window.json`.
 *
 * Why LiteLLM: it's the only widely-maintained machine-readable price
 * source covering Anthropic / OpenAI / Google + caching tier prices in
 * one place. Provider docs don't publish a machine-readable endpoint,
 * OpenRouter quotes their resold rate (not provider list price), and
 * scraping HTML breaks every redesign. LiteLLM's JSON gets community
 * PRs within hours of a public price change.
 *
 * Strategy:
 *   1. Fetch the upstream JSON.
 *   2. Keep only rows whose `litellm_provider` is one of ours.
 *   3. Normalize each LiteLLM key into our (provider, model) shape,
 *      stripping Anthropic-style date suffixes so `claude-opus-4-5-20251022`
 *      collapses onto our `claude-opus-4-5`.
 *   4. Compare against the most-recent row per (provider, model) in our
 *      book. Only write rows whose price OR capability flags actually
 *      changed — keeps `effective_from` history meaningful and avoids
 *      dupes when prices haven't moved.
 *   5. UPSERT with today's date.
 *
 * Hand-curated rows survive untouched: anything with a provider outside
 * the keep list (e.g. `scrapling`, future internal tool-cost rows) never
 * appears in the upstream feed so we leave it alone.
 *
 * Refusing-to-write behaviour: if upstream returns < 5 rows for any of
 * our kept providers, we treat that as a poisoned feed and abort. This
 * guards against a bad commit landing on litellm/main blanking our
 * catalog by upserting a degenerate set.
 */

export interface RefreshOptions {
  /** Override the upstream URL. Tests pass a local fixture. */
  url?: string;
  /** Override the effective_from date (YYYY-MM-DD). Tests pin this. */
  today?: string;
  /** Pass a custom fetcher. Tests / non-fetch runtimes plug in here. */
  fetcher?: (url: string) => Promise<unknown>;
}

export interface RefreshResult {
  /** How many upstream rows we considered after provider filter. */
  fetched: number;
  /** How many rows we actually wrote (price or flag delta). */
  written: number;
  /** Models we wrote (handy for the admin UI toast). */
  changedModels: Array<{ provider: string; model: string; reason: string }>;
  /** Models we deliberately skipped + why (so the operator can audit). */
  skipped: Array<{ source_name: string; reason: string }>;
}

interface PriceRow {
  provider: string;
  model: string;
  effective_from: string;
  input_per_million_usd: number;
  output_per_million_usd: number;
  cached_per_million_usd: number | null;
  cache_creation_per_million_usd: number | null;
  image_per_image_usd: number | null;
  supports_chat: boolean;
  supports_tools: boolean;
  supports_web_search: boolean;
  supports_image_gen: boolean;
  supports_embeddings: boolean;
  label: string;
}

// Minimal supabase surface — we use .from(...).select / .upsert. Avoids
// pulling @supabase/supabase-js types into the lib so this file is
// trivial to unit-test with an in-memory stub.
export interface SupabaseLike {
  from(table: string): {
    select: (cols: string) => {
      order: (col: string, opts: { ascending: boolean }) => Promise<{
        data: PriceRow[] | null;
        error: { message: string } | null;
      }>;
    };
    upsert: (
      rows: PriceRow[],
      opts: { onConflict: string },
    ) => Promise<{ error: { message: string } | null }>;
  };
}

const DEFAULT_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// LiteLLM uses these strings in its `litellm_provider` field. We keep
// only rows whose provider lands in this table; the value is what we
// write into our `provider` column.
const PROVIDER_MAP: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'gemini',
  // Anthropic models routed via Vertex AI carry a different provider tag
  // upstream but are the same pricing tier; remap so we don't end up
  // with two rows for one model.
  'vertex_ai-anthropic_models': 'anthropic',
  // Google models routed via Vertex AI.
  'vertex_ai-language-models': 'gemini',
};

const MIN_ROWS_PER_PROVIDER = 5;

// LiteLLM's mode → our supports_* flags.
const MODE_TO_FLAGS: Record<string, Partial<PriceRow>> = {
  chat: { supports_chat: true },
  completion: { supports_chat: true },
  embedding: { supports_embeddings: true },
  image_generation: { supports_image_gen: true },
};

/**
 * Strip date suffixes Anthropic and some Google models append: e.g.
 * `claude-opus-4-5-20251022` → `claude-opus-4-5`,
 * `gemini-2.5-pro-preview-06-05` → `gemini-2.5-pro`.
 *
 * Anthropic's date is always `-YYYYMMDD` at the end; Google's preview /
 * dated suffixes vary, so we strip a trailing `-preview-…` or
 * `-MM-DD` chunk too.
 */
export function normalizeModelName(provider: string, raw: string): string {
  // Strip everything after the model in `provider/model` if present
  // (vertex_ai entries look like `vertex_ai/claude-opus-4-5`). `split`
  // with `noUncheckedIndexedAccess` returns a possibly-undefined; the
  // ternary preserves `raw` as the fallback so the type stays `string`.
  const parts = raw.split('/');
  let m: string = parts.length > 1 ? parts[parts.length - 1] ?? raw : raw;
  // Vertex AI dated aliases use `@YYYYMMDD` or `@default` rather than
  // a hyphen — e.g. `vertex_ai/claude-opus-4-5@20251101`,
  // `claude-opus-4-6@default`. Collapse to the bare name so they
  // dedupe against the unsuffixed entry.
  m = m.replace(/@[A-Za-z0-9-]+$/, '');
  if (provider === 'anthropic') {
    // Trim `-YYYYMMDD` exactly. Don't trim shorter trailing numbers
    // because they're part of the version (4-5 / 4-7).
    return m.replace(/-\d{8}$/, '');
  }
  if (provider === 'gemini') {
    // Order matters: strip `-MM-DD` first because Google's preview names
    // are usually `<base>-preview-MM-DD`. After the date is gone the
    // `-preview` suffix is trivial to remove.
    return m
      .replace(/-\d{2}-\d{2}$/, '')
      .replace(/-preview(?:-\d+)?$/, '');
  }
  return m;
}

/** A pretty label when the upstream row doesn't have one. */
function humanizeName(name: string): string {
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b(claude|gpt|gemini|o)([0-9])/gi, (_, prefix, n) => `${prefix.toUpperCase()}-${n}`)
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Convert one LiteLLM definition into our PriceRow shape. Returns null
 * for upstream entries we can't model (no provider match, no price).
 */
export function mapLitellmRow(
  upstreamName: string,
  def: Record<string, unknown>,
  today: string,
): PriceRow | null {
  const upstreamProvider = String(def.litellm_provider ?? '');
  const provider = PROVIDER_MAP[upstreamProvider];
  if (!provider) return null;

  const mode = String(def.mode ?? 'chat');
  const flags: Partial<PriceRow> = {
    supports_chat: false,
    supports_tools: !!def.supports_function_calling,
    supports_web_search: !!def.supports_web_search,
    supports_image_gen: false,
    supports_embeddings: false,
    ...(MODE_TO_FLAGS[mode] ?? {}),
  };

  const input = Number(def.input_cost_per_token ?? 0) * 1_000_000;
  const output = Number(def.output_cost_per_token ?? 0) * 1_000_000;
  // Skip rows that have no pricing at all — usually an entry kept in
  // LiteLLM for capability detection rather than billing.
  if (input === 0 && output === 0 && mode !== 'image_generation') return null;

  const cached =
    def.cache_read_input_token_cost != null
      ? Number(def.cache_read_input_token_cost) * 1_000_000
      : null;
  const cacheCreate =
    def.cache_creation_input_token_cost != null
      ? Number(def.cache_creation_input_token_cost) * 1_000_000
      : null;
  const image =
    def.output_cost_per_image != null ? Number(def.output_cost_per_image) : null;

  const model = normalizeModelName(provider, upstreamName);
  const label =
    typeof def.display_name === 'string' && def.display_name
      ? def.display_name
      : humanizeName(model);

  return {
    provider,
    model,
    effective_from: today,
    input_per_million_usd: round4(input),
    output_per_million_usd: round4(output),
    cached_per_million_usd: cached != null ? round4(cached) : null,
    cache_creation_per_million_usd: cacheCreate != null ? round4(cacheCreate) : null,
    image_per_image_usd: image != null ? round4(image) : null,
    supports_chat: !!flags.supports_chat,
    supports_tools: !!flags.supports_tools,
    supports_web_search: !!flags.supports_web_search,
    supports_image_gen: !!flags.supports_image_gen,
    supports_embeddings: !!flags.supports_embeddings,
    label,
  };
}

function round4(n: number): number {
  // Round to 4 dp. Per-token prices like 1.5e-6 multiplied by 1M can
  // produce floats like 1.5000000000000002.
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Has anything material changed between the upstream row and the
 * latest row we already have? Capability flags + every price column —
 * anything else (label tweaks etc.) doesn't justify a new history row.
 */
function differs(latest: PriceRow | undefined, next: PriceRow): string | null {
  if (!latest) return 'new model';
  const keys: Array<keyof PriceRow> = [
    'input_per_million_usd',
    'output_per_million_usd',
    'cached_per_million_usd',
    'cache_creation_per_million_usd',
    'image_per_image_usd',
    'supports_chat',
    'supports_tools',
    'supports_web_search',
    'supports_image_gen',
    'supports_embeddings',
  ];
  for (const k of keys) {
    if (latest[k] !== next[k]) return `${k}: ${latest[k]} → ${next[k]}`;
  }
  return null;
}

const _defaultFetcher = async (url: string): Promise<unknown> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`upstream HTTP ${r.status}`);
  return r.json();
};

export async function refreshFromLitellm(
  supabase: SupabaseLike,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const url = opts.url ?? DEFAULT_URL;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const fetcher = opts.fetcher ?? _defaultFetcher;

  const upstream = await fetcher(url);
  if (!upstream || typeof upstream !== 'object') {
    throw new Error('upstream returned non-object payload');
  }

  const skipped: RefreshResult['skipped'] = [];
  const candidates: PriceRow[] = [];

  // LiteLLM keys the JSON by model name; some entries are special
  // marker rows (`sample_spec`) we skip.
  for (const [name, raw] of Object.entries(upstream as Record<string, unknown>)) {
    if (name === 'sample_spec' || !raw || typeof raw !== 'object') continue;
    const row = mapLitellmRow(name, raw as Record<string, unknown>, today);
    if (!row) {
      skipped.push({ source_name: name, reason: 'no provider match or zero pricing' });
      continue;
    }
    candidates.push(row);
  }

  // Sanity: if any kept provider produced fewer than MIN_ROWS_PER_PROVIDER
  // entries, treat the feed as poisoned and abort without writing.
  const perProviderCount = new Map<string, number>();
  for (const r of candidates) {
    perProviderCount.set(r.provider, (perProviderCount.get(r.provider) ?? 0) + 1);
  }
  const expectedProviders = new Set(Object.values(PROVIDER_MAP));
  for (const provider of expectedProviders) {
    const count = perProviderCount.get(provider) ?? 0;
    if (count < MIN_ROWS_PER_PROVIDER) {
      throw new Error(
        `upstream returned only ${count} rows for ${provider}; refusing to write (minimum ${MIN_ROWS_PER_PROVIDER})`,
      );
    }
  }

  // Collapse to one candidate per (provider, model). If LiteLLM ships
  // dated aliases (claude-opus-4-5-20251022 + claude-opus-4-5), they
  // both normalize to the same model — keep whichever has the higher
  // input price (latest dated revision typically wins; ties don't
  // matter).
  const byKey = new Map<string, PriceRow>();
  for (const r of candidates) {
    const key = `${r.provider}:${r.model}`;
    const prev = byKey.get(key);
    if (!prev || r.input_per_million_usd >= prev.input_per_million_usd) {
      byKey.set(key, r);
    }
  }

  // Pull our current latest-per-model snapshot to diff against.
  const existing = await supabase
    .from('ai_model_prices')
    .select('*')
    .order('effective_from', { ascending: false });
  if (existing.error) {
    throw new Error(`failed to read ai_model_prices: ${existing.error.message}`);
  }
  const latestByKey = new Map<string, PriceRow>();
  for (const row of existing.data ?? []) {
    const key = `${row.provider}:${row.model}`;
    if (!latestByKey.has(key)) latestByKey.set(key, row);
  }

  const toWrite: PriceRow[] = [];
  const changed: RefreshResult['changedModels'] = [];
  for (const next of byKey.values()) {
    const key = `${next.provider}:${next.model}`;
    const reason = differs(latestByKey.get(key), next);
    if (reason == null) continue;
    toWrite.push(next);
    changed.push({ provider: next.provider, model: next.model, reason });
  }

  if (toWrite.length > 0) {
    const up = await supabase
      .from('ai_model_prices')
      .upsert(toWrite, { onConflict: 'provider,model,effective_from' });
    if (up.error) throw new Error(`upsert failed: ${up.error.message}`);
  }

  return {
    fetched: candidates.length,
    written: toWrite.length,
    changedModels: changed,
    skipped,
  };
}
