// @ts-nocheck
/**
 * Phase cost pricing. Source of truth is the ai module's operator-editable price book
 * (public.ai_model_prices — litellm-refreshed, effective_from-versioned), read directly with the
 * worker's service-role client rather than via cross-module import (see resources/lib/
 * resolve-ai-module.ts for why dynamic module imports are a last resort). The compute mirrors
 * modules/ai/lib/cost.ts `computeCostMicroUsd` exactly so SE run costs agree with the platform's
 * AI usage dashboards: cache-creation falls back to the input rate when the book has no dedicated
 * rate; a null cached rate charges cache reads at 0 (the book's "no cache discount" contract).
 *
 * Returns null when the model has no price-book row — callers fall back to the Agent SDK's own
 * total_cost_usd, which is computed at Anthropic list prices.
 */

export interface PhaseUsage {
  input: number;         // uncached input tokens (usage.input_tokens)
  output: number;
  cacheRead: number;     // usage.cache_read_input_tokens
  cacheCreation: number; // usage.cache_creation_input_tokens
}

export async function pricePhaseCostUSD(
  sb: unknown,
  model: string,
  usage: PhaseUsage,
  opts: { provider?: 'anthropic' | 'openai'; occurredAt?: Date } = {},
): Promise<number | null> {
  const occurredAt = opts.occurredAt ?? new Date();
  if (!model) return null;
  const { data } = await sb
    .from('ai_model_prices')
    .select('input_per_million_usd, output_per_million_usd, cached_per_million_usd, cache_creation_per_million_usd')
    .eq('provider', opts.provider ?? 'anthropic')
    .eq('model', model)
    .lte('effective_from', occurredAt.toISOString().slice(0, 10))
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  // 1 token at $X/MTok = X micro-USD, so tokens * rate yields micro-USD directly.
  const cacheCreationRate = data.cache_creation_per_million_usd ?? data.input_per_million_usd;
  const micros =
    Math.round((usage.input ?? 0) * (data.input_per_million_usd ?? 0)) +
    Math.round((usage.output ?? 0) * (data.output_per_million_usd ?? 0)) +
    (data.cached_per_million_usd ? Math.round((usage.cacheRead ?? 0) * data.cached_per_million_usd) : 0) +
    Math.round((usage.cacheCreation ?? 0) * (cacheCreationRate ?? 0));
  return Math.round(micros / 100) / 10000; // micro-USD → USD at 4dp (matches cost_usd numeric(10,4))
}
