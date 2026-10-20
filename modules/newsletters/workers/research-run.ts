/**
 * Worker: one research run for one block of one edition.
 * spec-content-discovery-and-research-blocks.md §5.3.
 *
 * Job payload: { kind: 'newsletters:research-run', runId }. The run row was
 * inserted by the due cron (or an admin route) as `queued`; the partial
 * unique index on (block_id) WHERE status IN ('queued','running') is what
 * stops two ticks doubling the work.
 *
 * Steps: queued → running; resolve the input (discovery_posts query, or a
 * recipe); apply the transform (template, or a recipe); validate the output;
 * write the research layer through newsletters_research_write (one field,
 * open editions only, newer-run-wins, bumps the edition version); complete. Any
 * failure records failure_kind so the send gate and the UI can tell a cost
 * cap from a broken recipe.
 */

import type { Job } from 'bullmq';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { computeResearchWindow, type PreviousEditionRow } from '../lib/research-window.js';
import { queryDiscoveryPosts, type DiscoveryPostsInput } from '../lib/research-input.js';
import { runResearchRecipe, validateItems, ensureResearchThread, ResearchRecipeError, sanitizeInline } from '../lib/research-recipe.js';
import { stripTags } from '../lib/sanitize-inline.js';
import { bindingHash, researchOutputFormat } from '../lib/research-merge.js';

interface RunJobData { kind: string; runId: string }

interface RunRow {
  id: string; edition_id: string; block_id: string; block_def_id: string; binding: Binding; status: string; triggered_by: string;
}
interface Binding {
  kind: 'research';
  input: DiscoveryPostsInput | { kind: 'recipe'; use_case: string; params?: Record<string, string | number | boolean> };
  transform?: { kind: 'template'; group_by?: 'foundation' | 'project'; max_items?: number; max_per_group?: number; blurb?: 'first_sentence' | 'none'; suppress_release_titles?: boolean }
            | { kind: 'recipe'; use_case: string; params?: Record<string, string | number | boolean> };
  output: { field: string; format?: 'array' | 'richtext' | 'text' };
  schedule?: 'edition' | 'daily' | 'manual';
}

const sbFromEnv = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

export default async function handleResearchRun(job: Job<RunJobData>) {
  const runId = job.data?.runId;
  if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('[newsletters:research-run] runId missing');
  const sb = sbFromEnv();
  const log = (m: string) => console.log(`[newsletters:research-run ${runId.slice(0, 8)}] ${m}`);

  const { data: run, error } = await sb.from('newsletters_research_runs').select('id, edition_id, block_id, block_def_id, binding, status, triggered_by').eq('id', runId).maybeSingle();
  if (error || !run) { log(`run not found (${error?.message ?? 'no row'}); skipping`); return; }
  const r = run as unknown as RunRow;
  if (r.status !== 'queued') { log(`run is ${r.status}; skipping`); return; }

  // Conditional start: a run cancelled while queued must not execute (and spend).
  const start = await sb.from('newsletters_research_runs').update({ status: 'running' }).eq('id', runId).eq('status', 'queued').select('id');
  if (start.error) { log(`could not start: ${start.error.message}`); return; }
  if (!start.data?.length) { log('run was cancelled or taken before it started; skipping'); return; }

  const fail = async (kind: 'cost_cap' | 'recipe' | 'input' | 'stale' | 'output_invalid' | 'other', message: string, cost = 0) => {
    log(`FAILED (${kind}): ${message}`);
    // Only a run still running can fail: one cancelled or swept meanwhile
    // keeps its terminal state (the 093 guard would refuse the write anyway).
    const { error: fErr } = await sb.from('newsletters_research_runs').update({ status: 'failed', failure_kind: kind, error: message.slice(0, 2000), cost_micro_usd: cost }).eq('id', runId).eq('status', 'running');
    if (fErr) log(`could not record the failure: ${fErr.message}`);
    if (kind === 'cost_cap' || kind === 'stale') await notifyAdmins(sb, r, kind, message).catch(() => {});
  };

  try {
    const binding = r.binding;
    if (!binding || binding.kind !== 'research' || !binding.output?.field) return fail('input', 'run has no research binding');
    const field = binding.output.field;
    const format = researchOutputFormat(binding);
    let cost = 0;
    let aiThreadId: string | null = null;
    let inputSummary: Record<string, unknown> = {};

    // ── input ────────────────────────────────────────────────────────────
    let items: Array<Record<string, unknown>> = [];
    let scalar: unknown = null;
    let inputKeys: Set<string> | null = null;
    let inputByKey: Map<string, { url: string }> | null = null;
    if (binding.input.kind === 'discovery_posts') {
      const ctx = await loadWindowContext(sb, r);
      const w = (binding.input as { window?: unknown }).window;
      const fixedDays = w && typeof w === 'object' && typeof (w as { days?: unknown }).days === 'number' ? (w as { days: number }).days : null;
      const win = computeResearchWindow({ now: new Date(), previous: ctx.previous, cadenceDays: ctx.cadenceDays, timezone: ctx.timezone, cadenceHour: ctx.cadenceHour, fixedDays });
      const t = binding.transform?.kind === 'template' ? binding.transform : undefined;
      const res = await queryDiscoveryPosts(sb, binding.input, win, { groupBy: t?.group_by ?? 'foundation', blurb: t?.blurb, suppressReleaseTitles: t?.suppress_release_titles });
      inputKeys = new Set(res.items.map((i) => i.key));
      inputByKey = new Map(res.items.map((i) => [i.key, { url: i.url }]));
      // Template-path items are built from external feed titles and excerpts;
      // they go through the same validator as recipe output.
      items = validateItems(res.items, { inputKeys, inputByKey });
      inputSummary = { kind: 'discovery_posts', ...res.summary, items: items.length };
      log(`discovery_posts: ${items.length} items (window ${win.anchor} ${win.from} → ${win.to}, ${res.summary.excluded_previous} excluded as already used)`);
    } else {
      const useCase = binding.input.use_case;
      aiThreadId = await ensureResearchThread(sb, useCase, r.block_id, runId);
      await sb.from('newsletters_research_runs').update({ ai_thread_id: aiThreadId }).eq('id', runId);
      const out = await runResearchRecipe(sb, useCase, r.block_id, { ...(binding.input.params ?? {}), edition_id: r.edition_id }, { log });
      cost += out.costMicroUsd;
      if (format === 'array') items = validateItems(out.output, { inputKeys: null });
      else scalar = out.output;
      inputSummary = { kind: 'recipe', use_case: useCase, items: items.length, cost_micro_usd: out.costMicroUsd };
      log(`recipe input ${useCase}: ${format === 'array' ? items.length + ' items' : 'scalar output'}`);
    }

    // ── transform ────────────────────────────────────────────────────────
    if (binding.transform?.kind === 'recipe') {
      const useCase = binding.transform.use_case;
      aiThreadId = aiThreadId ?? (await ensureResearchThread(sb, useCase, r.block_id, runId));
      await sb.from('newsletters_research_runs').update({ ai_thread_id: aiThreadId }).eq('id', runId);
      const out = await runResearchRecipe(sb, useCase, r.block_id, { ...(binding.transform.params ?? {}), edition_id: r.edition_id, input_json: JSON.stringify(format === 'array' ? items : scalar).slice(0, 200_000) }, { log });
      cost += out.costMicroUsd;
      if (format === 'array') items = validateItems(out.output, { inputKeys, inputByKey });
      else scalar = out.output;
      inputSummary = { ...inputSummary, transform_use_case: useCase, transform_cost_micro_usd: out.costMicroUsd };
    }

    // ── output ───────────────────────────────────────────────────────────
    let value: unknown;
    if (format === 'array') value = items;
    else {
      const text = typeof scalar === 'string' ? scalar : (scalar && typeof scalar === 'object' ? String((scalar as Record<string, unknown>).text ?? (scalar as Record<string, unknown>).html ?? (scalar as Record<string, unknown>).summary ?? '') : '');
      if (!text.trim()) throw new ResearchRecipeError('output_invalid', 'recipe produced no text');
      value = format === 'richtext' ? sanitizeInline(text, { allowAnchors: true }) : stripTags(sanitizeInline(text));
    }

    const hash = await bindingHash(binding);
    const { data: version, error: wErr } = await sb.rpc('newsletters_research_write', { p_block_id: r.block_id, p_field: field, p_value: value as never, p_run_id: runId });
    if (wErr) {
      if (/SUPERSEDED_BY_NEWER_RUN/.test(wErr.message)) {
        log('a newer run already completed; this output is kept on the run but not applied');
        await sb.from('newsletters_research_runs').update({ status: 'complete', output: value as never, input_summary: inputSummary, cost_micro_usd: cost, binding_hash: hash, error: 'superseded: not applied' }).eq('id', runId);
        return;
      }
      if (/EDITION_NOT_OPEN/.test(wErr.message)) return fail('other', `edition has started sending or is no longer a draft or published: ${wErr.message}`, cost);
      throw new Error(`research write failed: ${wErr.message}`);
    }
    const done = await sb.from('newsletters_research_runs').update({ status: 'complete', output: value as never, input_summary: inputSummary, cost_micro_usd: cost, binding_hash: hash }).eq('id', runId).select('id');
    if (done.error || !done.data?.length) log(`WARN completion not recorded (${done.error?.message ?? 'no row'}); the run may have been cancelled mid-flight`);
    else log(`complete → ${field} (edition version ${version})`);
  } catch (e) {
    if (e instanceof ResearchRecipeError) return fail(e.kind, e.message);
    return fail('other', e instanceof Error ? e.message : String(e));
  }
}

/** The previous edition in the same collection and what it already used for this block def. */
async function loadWindowContext(sb: SupabaseClient, r: RunRow) {
  const ed = await sb.from('newsletters_editions').select('id, collection_id, send_target_at, edition_date').eq('id', r.edition_id).maybeSingle();
  const edition = ed.data as { collection_id: string | null; send_target_at: string | null; edition_date: string } | null;
  let cadenceDays: number | null = null;
  let timezone: string | null = null;
  let cadenceHour: number | null = null;
  if (edition?.collection_id) {
    const col = await sb.from('newsletters_template_collections').select('cadence').eq('id', edition.collection_id).maybeSingle();
    const c = (col.data as { cadence?: Record<string, unknown> } | null)?.cadence ?? null;
    if (c) {
      cadenceDays = c.freq === 'weekly' ? 7 : c.freq === 'biweekly' ? 14 : c.freq === 'monthly' ? 30 : null;
      timezone = typeof c.timezone === 'string' ? c.timezone : null;
      cadenceHour = typeof c.hour === 'number' ? c.hour : null;
    }
  }
  let previous: PreviousEditionRow | null = null;
  if (edition?.collection_id) {
    const anchorTime = edition.send_target_at ?? `${edition.edition_date}T23:59:59Z`;
    const prev = await sb
      .from('newsletters_editions')
      .select('id, edition_date, send_target_at, metadata, newsletter_sends!inner(status)')
      .eq('collection_id', edition.collection_id)
      .neq('id', r.edition_id)
      .in('newsletter_sends.status', ['sent', 'sending'])
      .or(`send_target_at.lt.${anchorTime},and(send_target_at.is.null,edition_date.lt.${edition.edition_date})`)
      .order('edition_date', { ascending: false })
      .limit(5);
    const rows = ((prev.data ?? []) as Array<{ id: string; edition_date: string; send_target_at: string | null; metadata: Record<string, unknown> | null }>).filter((p) => !(p.metadata && p.metadata.special === true));
    const p = rows[0];
    if (p) {
      // That edition's block of the same def, its latest completed run and the keys in its research layer.
      const blk = await sb.from('newsletters_edition_blocks').select('id, content').eq('edition_id', p.id).eq('templates_block_def_id', r.block_def_id).is('deleted_at', null).limit(1).maybeSingle();
      const b = blk.data as { id: string; content: Record<string, unknown> } | null;
      let researchStartedAt: string | null = null;
      let keys: string[] = [];
      if (b) {
        // The window starts where the previous edition's own research started:
        // its latest completed SCHEDULED run. A revert re-applies old output
        // and a daily run is not the edition's research, so neither counts; a
        // manual run is the fallback for an edition that never had a schedule.
        const lastOf = (trigger: 'schedule' | 'manual') =>
          sb.from('newsletters_research_runs').select('started_at, binding').eq('block_id', b.id).eq('status', 'complete').eq('triggered_by', trigger).order('seq', { ascending: false }).limit(1).maybeSingle();
        let lastRun = await lastOf('schedule');
        if (!lastRun.error && !lastRun.data) lastRun = await lastOf('manual');
        const lr = lastRun.data as { started_at: string | null; binding: Binding } | null;
        researchStartedAt = lr?.started_at ?? null;
        const field = lr?.binding?.output?.field ?? r.binding?.output?.field;
        const layer = field ? b.content?.[field] : null;
        if (Array.isArray(layer)) keys = layer.map((i) => (i && typeof i === 'object' ? (i as { key?: unknown }).key : null)).filter((k): k is string => typeof k === 'string');
      }
      previous = { id: p.id, edition_date: p.edition_date, send_target_at: p.send_target_at, research_started_at: researchStartedAt, research_keys: keys };
    }
  }
  return { previous, cadenceDays, timezone, cadenceHour };
}

/**
 * Tell the collection's admins. The newsletters module has no dedicated
 * alert channel; the scraper-alerts helper in the scrapers module is the
 * platform's existing operator alert path (Slack/Pushover per config), so
 * reuse it when present and log otherwise.
 */
async function notifyAdmins(sb: SupabaseClient, r: RunRow, kind: string, message: string) {
  const ed = await sb.from('newsletters_editions').select('title').eq('id', r.edition_id).maybeSingle();
  const title = (ed.data as { title?: string } | null)?.title ?? r.edition_id;
  try {
    // Plain-JS helper in the scrapers module with no type declarations; the
    // path is held in a variable so the import is typed by the cast below.
    const alertsPath = '../../scrapers/scripts/lib/scraper-alerts.js';
    const alerts = (await import(alertsPath)) as { sendScraperAlert: (a: { severity: string; title: string; message: string; scraperName?: string; jobId?: string }) => Promise<void> };
    await alerts.sendScraperAlert({ severity: 'warning', title: `Newsletter research ${kind}: ${title}`, message, scraperName: 'newsletters:research-run', jobId: r.id });
  } catch {
    console.warn(`[newsletters:research-run] ALERT ${kind} for edition "${title}": ${message}`);
  }
}
