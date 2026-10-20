/**
 * Recipe steps for research blocks: load a use case's bound recipe, do the
 * cost-cap pre-flight (the goose executor has none), create the ai_threads
 * row the chat widget attaches to, run it, and validate what came back.
 * spec-content-discovery-and-research-blocks.md §5.1, §5.3.
 *
 * The ai module lives in this same repo, so it is reached by relative
 * dynamic import (the newsletters routes already do this for the sites
 * module). Everything from the recipe is treated as untrusted output.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sanitizeInline } from './sanitize-inline.js';

export { sanitizeInline };

export const RESEARCH_HOST_KIND = 'newsletter_block';

type RecipeRow = {
  id: string; file_path: string; version: string | null; title: string; description: string | null; instructions: string;
  prompt: string | null; parameters: unknown[]; response_schema: unknown; settings: Record<string, unknown>;
  sub_recipe_refs: Array<{ path: string } & Record<string, unknown>>; extensions: unknown[]; content_hash: string;
  parse_status: 'ok' | 'refused' | 'parse_error';
};
const RECIPE_COLS = 'id, file_path, version, title, description, instructions, prompt, parameters, response_schema, settings, sub_recipe_refs, extensions, content_hash, parse_status';

// ai_recipes has no skills column (the recipe YAML `skills:` list is parsed
// and dropped at sync; see the lunch-and-learn notes), so skills is empty and
// the recipe's own "auto-loaded skill" phrasing does the loading.
const toParsed = (r: RecipeRow) => ({
  version: r.version, title: r.title, description: r.description, instructions: r.instructions, prompt: r.prompt,
  parameters: r.parameters, response_schema: r.response_schema, settings: r.settings, sub_recipes: r.sub_recipe_refs,
  extensions: r.extensions, content_hash: r.content_hash, skills: [] as string[],
});

export class ResearchRecipeError extends Error {
  kind: 'cost_cap' | 'recipe' | 'input' | 'output_invalid';
  constructor(kind: ResearchRecipeError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** The use case's recipe binding, or a typed refusal. */
export async function loadRecipeBinding(sb: SupabaseClient, useCaseId: string) {
  if (!/^newsletter-[a-z0-9_-]{1,90}$/.test(useCaseId)) throw new ResearchRecipeError('recipe', `use case ${useCaseId} is not a newsletter research use case`);
  const uc = await sb.from('ai_use_cases').select('id, recipe_source_id, recipe_file_path, daily_cost_cap_micro_usd').eq('id', useCaseId).maybeSingle();
  if (uc.error || !uc.data) throw new ResearchRecipeError('recipe', `use case ${useCaseId} not found`);
  const u = uc.data as { recipe_source_id: string | null; recipe_file_path: string | null; daily_cost_cap_micro_usd: number | null };
  if (!u.recipe_source_id || !u.recipe_file_path) throw new ResearchRecipeError('recipe', `use case ${useCaseId} has no recipe binding (bind one at /admin/ai/use-cases)`);
  const rec = await sb.from('ai_recipes').select(RECIPE_COLS).eq('source_id', u.recipe_source_id).eq('file_path', u.recipe_file_path).maybeSingle();
  if (rec.error || !rec.data) throw new ResearchRecipeError('recipe', `recipe ${u.recipe_file_path} not synced for use case ${useCaseId}`);
  const row = rec.data as unknown as RecipeRow;
  if (row.parse_status !== 'ok') throw new ResearchRecipeError('recipe', `recipe ${row.file_path} parse_status=${row.parse_status}`);
  const recipe = toParsed(row);
  const subRecipes = new Map<string, ReturnType<typeof toParsed>>();
  if (recipe.sub_recipes?.length) {
    const sub = await sb.from('ai_recipes').select(RECIPE_COLS).eq('source_id', u.recipe_source_id).in('file_path', recipe.sub_recipes.map((s) => s.path));
    for (const s of (sub.data ?? []) as unknown as RecipeRow[]) {
      if (s.parse_status !== 'ok') throw new ResearchRecipeError('recipe', `sub-recipe ${s.file_path} parse_status=${s.parse_status}`);
      subRecipes.set(s.file_path, toParsed(s));
    }
    for (const ref of recipe.sub_recipes) if (!subRecipes.has(ref.path)) throw new ResearchRecipeError('recipe', `sub-recipe missing: ${ref.path}`);
  }
  return { useCaseId, recipeId: row.id, filePath: row.file_path, recipe, subRecipes, dailyCapMicroUsd: u.daily_cost_cap_micro_usd };
}

/**
 * Cost-cap pre-flight. The chat runner has one; the goose recipe executor
 * does not, so research does its own before spending anything. Estimate is
 * the use case's average cost over its last 20 runs, else a conservative
 * default.
 */
export const DEFAULT_RESEARCH_DAILY_CAP_MICRO_USD = Number(process.env.NEWSLETTER_RESEARCH_DEFAULT_CAP_MICRO_USD) || 5_000_000; // $5/day when the use case sets none

export async function assertUnderCostCap(sb: SupabaseClient, useCaseId: string, capMicroUsd: number | null) {
  // A use case with no cap would be unlimited spend driven by a template file; research uses a default instead.
  if (capMicroUsd == null) capMicroUsd = DEFAULT_RESEARCH_DAILY_CAP_MICRO_USD;
  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  const costLib = await import('../../ai/lib/cost.js');
  const spent: number = await costLib.sumSpentMicroUsd(sb as never, { useCase: useCaseId, fromIso: from.toISOString() });
  const recent = await sb.from('ai_usage_events').select('cost_micro_usd').eq('use_case', useCaseId).order('occurred_at', { ascending: false }).limit(20);
  const costs = ((recent.data ?? []) as Array<{ cost_micro_usd: number | string }>).map((r) => Number(r.cost_micro_usd) || 0);
  const estimate = costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) / costs.length) * 3 : 500_000; // 3 calls' worth, or $0.50
  if (spent + estimate > capMicroUsd) {
    throw new ResearchRecipeError('cost_cap', `use case ${useCaseId}: spent ${spent} + estimate ${estimate} micro-USD would exceed the daily cap ${capMicroUsd}`);
  }
  return { spent, estimate, cap: capMicroUsd };
}

/** The ai_threads row the chat widget mounts on: (use_case, newsletter_block, block id, thread_key). */
export async function ensureResearchThread(sb: SupabaseClient, useCaseId: string, blockId: string, threadKey: string): Promise<string> {
  const sel = await sb.from('ai_threads').select('id').eq('use_case', useCaseId).eq('host_kind', RESEARCH_HOST_KIND).eq('host_id', blockId).eq('thread_key', threadKey).maybeSingle();
  if (sel.data?.id) return sel.data.id as string;
  const ins = await sb.from('ai_threads').insert({ use_case: useCaseId, host_kind: RESEARCH_HOST_KIND, host_id: blockId, thread_key: threadKey, status: 'idle' }).select('id').maybeSingle();
  if (ins.error && /unique/i.test(ins.error.message)) {
    const again = await sb.from('ai_threads').select('id').eq('use_case', useCaseId).eq('host_kind', RESEARCH_HOST_KIND).eq('host_id', blockId).eq('thread_key', threadKey).maybeSingle();
    if (again.data?.id) return again.data.id as string;
  }
  if (ins.error || !ins.data) throw new ResearchRecipeError('recipe', `could not create the research thread: ${ins.error?.message ?? 'unknown'}`);
  return ins.data.id as string;
}

export interface RecipeRunOutcome {
  output: unknown;
  costMicroUsd: number;
  runId: string | null;
}

/** Run the use case's recipe with `params`; returns the final structured output. */
export async function runResearchRecipe(
  sb: SupabaseClient,
  useCaseId: string,
  blockId: string,
  params: Record<string, string | number | boolean>,
  logger?: { log: (m: string) => void },
): Promise<RecipeRunOutcome> {
  const binding = await loadRecipeBinding(sb, useCaseId);
  await assertUnderCostCap(sb, useCaseId, binding.dailyCapMicroUsd);
  const mod = await import('../../ai/lib/recipes/run-recipe.js');
  const result = await mod.runRecipe(
    sb as never,
    { supabase: sb as never, logger: logger ?? console } as never,
    {
      // Built from the ai_recipes row the way daily-briefing does; structurally
      // the same as ParsedRecipe but typed from DB columns, hence the casts.
      recipe: binding.recipe as never,
      subRecipes: binding.subRecipes as never,
      params,
      userId: null,
      useCase: useCaseId,
      hostKind: RESEARCH_HOST_KIND,
      hostId: blockId,
      recipeId: binding.recipeId,
      recipeFilePath: binding.filePath,
    },
  );
  if (result.status === 'budget_blocked') throw new ResearchRecipeError('cost_cap', `use case ${useCaseId} was budget-blocked by the runner`);
  if (result.status !== 'complete') throw new ResearchRecipeError('recipe', `recipe run ${result.run_id} ended ${result.status}`);
  return { output: result.final_output, costMicroUsd: result.total_cost_micro_usd ?? 0, runId: result.run_id ?? null };
}

/** Fields an array item may carry; anything else is dropped. */
export const ITEM_FIELDS = new Set(['key', 'group', 'headline', 'url', 'source', 'foundation', 'published_at', 'date_label', 'summary', 'tag']);
const MAX_ITEM_CHARS = 4000;

export interface ItemValidationOpts {
  /** Keys the item must come from (discovery_posts input); null for a pure recipe input. */
  inputKeys: Set<string> | null;
  /** Input items by key, so an item's url is taken from the input that owns its key, never from the model. */
  inputByKey?: Map<string, { url: string }> | null;
  maxItems?: number;
}

/**
 * Validate an array output, whether it came from the template path or a
 * recipe: allow-listed scalar fields only, a size cap per item, keys unique
 * and (for discovery inputs) from the input set, `url` https and owned by the
 * key's input item, every other string reduced to text with a tiny inline
 * allow-list and NO anchors (the block's own url field is the only link).
 * Returns the cleaned items or throws output_invalid.
 */
export function validateItems(raw: unknown, opts: ItemValidationOpts): Array<Record<string, unknown>> {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : null);
  if (!list) throw new ResearchRecipeError('output_invalid', 'output is not an array (or {items: [...]})');
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const it of list.slice(0, opts.maxItems ?? 500)) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw new ResearchRecipeError('output_invalid', 'an item is not an object');
    const src = it as Record<string, unknown>;
    const item: Record<string, unknown> = {};
    let size = 0;
    for (const [k, v] of Object.entries(src)) {
      if (!ITEM_FIELDS.has(k)) continue;
      if (v == null) continue;
      if (typeof v === 'object') throw new ResearchRecipeError('output_invalid', `item field ${k} must be a scalar`);
      const str = String(v);
      size += str.length;
      if (size > MAX_ITEM_CHARS) throw new ResearchRecipeError('output_invalid', 'item exceeds 4000 characters');
      item[k] = k === 'url' ? str.trim() : sanitizeInline(str, { allowAnchors: false });
    }
    let key = typeof item.key === 'string' ? item.key : '';
    if (opts.inputKeys) {
      if (!key || !opts.inputKeys.has(key)) throw new ResearchRecipeError('output_invalid', `item key missing or not from the input set: ${key.slice(0, 80)}`);
      const owner = opts.inputByKey?.get(key);
      if (owner) item.url = owner.url; // the input decides where a key points, not the model
    } else if (!key) {
      key = typeof item.url === 'string' && item.url ? normalizeForCompare(item.url) : `h:${hashText(String(item.headline ?? ''))}`;
    }
    const url = typeof item.url === 'string' ? item.url : '';
    if (url && (!/^https:\/\/[^\s<>"']+$/i.test(url) || url.length > 2048)) throw new ResearchRecipeError('output_invalid', `item url is not https: ${url.slice(0, 80)}`);
    if (seen.has(key)) throw new ResearchRecipeError('output_invalid', `duplicate item key ${key.slice(0, 80)}`);
    seen.add(key);
    item.key = key;
    out.push(item);
  }
  return out;
}

/** @deprecated use validateItems */
export const validateRecipeItems = (raw: unknown, opts: { inputKeys: Set<string> | null; inputUrls?: Set<string> | null; maxItems?: number }) => validateItems(raw, { inputKeys: opts.inputKeys, maxItems: opts.maxItems });

export function normalizeForCompare(url: string): string {
  return String(url).trim().replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/#.*$/, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();
}

function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
