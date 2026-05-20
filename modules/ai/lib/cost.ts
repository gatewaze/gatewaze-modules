/**
 * Cost ledger.
 *
 * `recordUsage()` writes one row to `ai_usage_events` per LLM, embedding,
 * image, or tool call. cost_micro_usd is computed at write time from
 * `ai_price_at(provider, model, occurred_at)`, so historical rows stay
 * accurate even after price-book updates.
 *
 * `estimateMaxCost()` is the pre-flight gate that lets the runner reject
 * a call that would push past a use-case's daily cap.
 */

import type { KnownProvider } from './providers/types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = { from(table: string): any; rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };

export interface UsageEventInput {
  occurredAt?: Date;
  userId: string | null;
  useCase: string;
  threadId: string | null;
  messageId: string | null;
  kind: 'llm' | 'tool' | 'embedding' | 'image';
  // 'scrapling' attributes fetch_url tool calls; 'serper' attributes
  // gatewaze_search invocations that hit the Serper.dev backend.
  provider: KnownProvider | 'scrapling' | 'serper';
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /**
   * Anthropic cache-creation tokens — billed at ~1.25× the regular
   * input rate (a one-time premium for writing the cache, recouped on
   * subsequent reads at 0.1×). Separate from cachedTokens (cache reads).
   * Capture from `usage.cache_creation_input_tokens` on Anthropic
   * responses. OpenAI / Gemini don't currently expose an equivalent
   * counter, so leave undefined for those providers.
   */
  cacheCreationTokens?: number;
  imageOutputs?: number;
  bytesIn?: number;
  bytesOut?: number;
  browserSeconds?: number;
  latencyMs?: number;
  status: 'ok' | 'error' | 'rate_limited' | 'timeout' | 'budget_blocked' | 'cancelled';
  error?: string | null;
  requestId?: string | null;
  /**
   * Skip the price-book lookup and write this exact value. Used by
   * callers that have their own cost estimate (e.g. editor-ai-copilot's
   * per-tool fixed cost from env config, or gatewaze-fetch's per-mode
   * tiered cost). Leave undefined for the default token-based compute.
   */
  costMicroUsdOverride?: number;
}

export interface UsageEventRow extends UsageEventInput {
  id: string;
  costMicroUsd: number;
}

interface PriceRow {
  input_per_million_usd: number;
  output_per_million_usd: number;
  cached_per_million_usd: number | null;
  cache_creation_per_million_usd: number | null;
  image_per_image_usd: number | null;
}

/**
 * Compute cost in micro-USD from token counts + price book.
 * micro-USD = USD * 1_000_000.
 */
export function computeCostMicroUsd(
  price: PriceRow,
  e: Pick<UsageEventInput, 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'cacheCreationTokens' | 'imageOutputs' | 'kind'>,
): number {
  const inputTok = e.inputTokens ?? 0;
  const outputTok = e.outputTokens ?? 0;
  const cachedTok = e.cachedTokens ?? 0;
  const cacheCreationTok = e.cacheCreationTokens ?? 0;
  const images = e.imageOutputs ?? 0;

  // Tokens × $/M → micro-USD requires *1_000_000/1_000_000 = identity;
  // but expressing as integer math avoids float drift.
  const inputMicros = Math.round(inputTok * price.input_per_million_usd);
  const outputMicros = Math.round(outputTok * price.output_per_million_usd);
  const cachedMicros = price.cached_per_million_usd
    ? Math.round(cachedTok * price.cached_per_million_usd)
    : 0;
  // Cache-creation pricing: fall back to the regular input rate when
  // the price book doesn't have a dedicated entry (per migration 011's
  // contract — `NULL means no premium`).
  const cacheCreationRate =
    price.cache_creation_per_million_usd ?? price.input_per_million_usd;
  const cacheCreationMicros = Math.round(cacheCreationTok * cacheCreationRate);
  const imageMicros = price.image_per_image_usd
    ? Math.round(images * price.image_per_image_usd * 1_000_000)
    : 0;
  return inputMicros + outputMicros + cachedMicros + cacheCreationMicros + imageMicros;
}

export async function recordUsage(
  supabase: SupabaseClient,
  event: UsageEventInput,
): Promise<UsageEventRow> {
  const occurredAt = event.occurredAt ?? new Date();

  let costMicroUsd: number;
  if (typeof event.costMicroUsdOverride === 'number') {
    // Caller-supplied cost (e.g. editor-ai-copilot's per-tool fixed
    // cost from env, or gatewaze-fetch's per-mode tiered cost). Skip
    // the price-book lookup entirely.
    costMicroUsd = event.costMicroUsdOverride;
  } else {
    // Default path: compute from the price book.
    const priceLookup = await supabase
      .from('ai_model_prices')
      .select('input_per_million_usd, output_per_million_usd, cached_per_million_usd, cache_creation_per_million_usd, image_per_image_usd')
      .eq('provider', event.provider)
      .eq('model', event.model)
      .lte('effective_from', occurredAt.toISOString().slice(0, 10))
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle();
    const price: PriceRow | null = (priceLookup.data as PriceRow | null) ?? null;
    costMicroUsd = price ? computeCostMicroUsd(price, event) : 0;
  }

  const insertRes = await supabase
    .from('ai_usage_events')
    .insert({
      occurred_at: occurredAt.toISOString(),
      user_id: event.userId,
      use_case: event.useCase,
      thread_id: event.threadId,
      message_id: event.messageId,
      kind: event.kind,
      provider: event.provider,
      model: event.model,
      input_tokens: event.inputTokens ?? 0,
      output_tokens: event.outputTokens ?? 0,
      cached_tokens: event.cachedTokens ?? 0,
      cache_creation_tokens: event.cacheCreationTokens ?? 0,
      image_outputs: event.imageOutputs ?? 0,
      bytes_in: event.bytesIn ?? 0,
      bytes_out: event.bytesOut ?? 0,
      browser_seconds: event.browserSeconds ?? 0,
      cost_micro_usd: costMicroUsd,
      latency_ms: event.latencyMs ?? 0,
      status: event.status,
      error: event.error ?? null,
      request_id: event.requestId ?? null,
    })
    .select('id')
    .maybeSingle();
  if (insertRes.error || !insertRes.data) {
    throw new Error(`ai_usage_events insert failed: ${insertRes.error?.message ?? 'no row'}`);
  }
  return { ...event, id: insertRes.data.id, costMicroUsd };
}

/**
 * Pre-flight cost estimate. Worst-case = input_tokens + max_output_tokens
 * priced at the resolved model. Used by the runner to reject calls that
 * would breach a use-case's daily soft cap.
 */
export async function estimateMaxCost(
  supabase: SupabaseClient,
  args: { provider: KnownProvider; model: string; inputTokens: number; maxOutputTokens: number },
): Promise<number> {
  const priceLookup = await supabase
    .from('ai_model_prices')
    .select('input_per_million_usd, output_per_million_usd')
    .eq('provider', args.provider)
    .eq('model', args.model)
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();
  const price = priceLookup.data as
    | { input_per_million_usd: number; output_per_million_usd: number }
    | null;
  if (!price) return 0;
  return (
    Math.round(args.inputTokens * price.input_per_million_usd) +
    Math.round(args.maxOutputTokens * price.output_per_million_usd)
  );
}

/**
 * Today's call_count + cost_micro_usd for a (use_case, provider, model)
 * triple. Used by editor-ai-copilot's per-tool budget gate to decide
 * whether to strip a web tool from the next request.
 *
 * Returns zero counters when no rows exist yet — opens the gate by
 * default rather than blocking on first use.
 */
export async function sumTodayToolUsage(
  supabase: SupabaseClient,
  args: { useCase: string; provider: string; model: string },
): Promise<{ callCount: number; costMicroUsd: number }> {
  const startIso = startOfTodayIso();
  const result = await supabase
    .from('ai_usage_events')
    .select('cost_micro_usd')
    .eq('use_case', args.useCase)
    .eq('provider', args.provider)
    .eq('model', args.model)
    .eq('status', 'ok')
    .gte('occurred_at', startIso);
  const rows = (result.data ?? []) as Array<{ cost_micro_usd: number | string }>;
  let cost = 0;
  for (const r of rows) {
    cost += typeof r.cost_micro_usd === 'number'
      ? r.cost_micro_usd
      : parseInt(String(r.cost_micro_usd), 10) || 0;
  }
  return { callCount: rows.length, costMicroUsd: cost };
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Sum micro-USD spend for a use-case over a date range. Used by the
 * pre-flight budget gate + the dashboard.
 */
export async function sumSpentMicroUsd(
  supabase: SupabaseClient,
  args: { useCase: string; fromIso: string; toIso?: string },
): Promise<number> {
  const result = await supabase
    .from('ai_usage_events')
    .select('cost_micro_usd')
    .eq('use_case', args.useCase)
    .gte('occurred_at', args.fromIso)
    .lte('occurred_at', args.toIso ?? new Date().toISOString());
  let total = 0;
  for (const row of (result.data ?? []) as Array<{ cost_micro_usd: number | string }>) {
    total += typeof row.cost_micro_usd === 'number'
      ? row.cost_micro_usd
      : parseInt(String(row.cost_micro_usd), 10) || 0;
  }
  return total;
}
