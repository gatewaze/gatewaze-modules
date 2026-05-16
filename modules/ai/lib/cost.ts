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
  provider: KnownProvider | 'scrapling';
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  imageOutputs?: number;
  bytesIn?: number;
  bytesOut?: number;
  browserSeconds?: number;
  latencyMs?: number;
  status: 'ok' | 'error' | 'rate_limited' | 'timeout' | 'budget_blocked' | 'cancelled';
  error?: string | null;
  requestId?: string | null;
}

export interface UsageEventRow extends UsageEventInput {
  id: string;
  costMicroUsd: number;
}

interface PriceRow {
  input_per_million_usd: number;
  output_per_million_usd: number;
  cached_per_million_usd: number | null;
  image_per_image_usd: number | null;
}

/**
 * Compute cost in micro-USD from token counts + price book.
 * micro-USD = USD * 1_000_000.
 */
export function computeCostMicroUsd(
  price: PriceRow,
  e: Pick<UsageEventInput, 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'imageOutputs' | 'kind'>,
): number {
  const inputTok = e.inputTokens ?? 0;
  const outputTok = e.outputTokens ?? 0;
  const cachedTok = e.cachedTokens ?? 0;
  const images = e.imageOutputs ?? 0;

  // Tokens × $/M → micro-USD requires *1_000_000/1_000_000 = identity;
  // but expressing as integer math avoids float drift.
  const inputMicros = Math.round(inputTok * price.input_per_million_usd);
  const outputMicros = Math.round(outputTok * price.output_per_million_usd);
  const cachedMicros = price.cached_per_million_usd
    ? Math.round(cachedTok * price.cached_per_million_usd)
    : 0;
  const imageMicros = price.image_per_image_usd
    ? Math.round(images * price.image_per_image_usd * 1_000_000)
    : 0;
  return inputMicros + outputMicros + cachedMicros + imageMicros;
}

export async function recordUsage(
  supabase: SupabaseClient,
  event: UsageEventInput,
): Promise<UsageEventRow> {
  const occurredAt = event.occurredAt ?? new Date();

  // Price lookup via the SQL helper. Returns the row in effect at
  // `occurredAt`; null for unknown (provider, model) — we still write
  // the usage row but cost_micro_usd defaults to 0 so operators can
  // detect missing price-book entries.
  const priceLookup = await supabase
    .from('ai_model_prices')
    .select('input_per_million_usd, output_per_million_usd, cached_per_million_usd, image_per_image_usd')
    .eq('provider', event.provider)
    .eq('model', event.model)
    .lte('effective_from', occurredAt.toISOString().slice(0, 10))
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();
  const price: PriceRow | null = (priceLookup.data as PriceRow | null) ?? null;
  const costMicroUsd = price ? computeCostMicroUsd(price, event) : 0;

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
