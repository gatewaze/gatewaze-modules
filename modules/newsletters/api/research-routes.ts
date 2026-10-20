/**
 * Admin API for research blocks (spec-content-discovery-and-research-blocks
 * §5.3, §5.4). Mounted on the newsletters admin router (/api/admin/...),
 * behind requireJwt; each handler ALSO checks is_admin() as the caller,
 * because a JWT alone is any signed-in portal member (module-route-authz.md).
 *
 *   GET  /newsletters/editions/:editionId/research           latest run per block + the send gate
 *   POST /newsletters/editions/:editionId/research/run       { block_id? } → queue a manual run (all research blocks when omitted)
 *   POST /newsletters/research/runs/:runId/cancel
 *   POST /newsletters/research/runs/:runId/revert            re-apply that run's output as a new `revert` run
 *   GET  /newsletters/editions/:editionId/research/runs      history (last 50)
 */

import type { Router, Request, Response, NextFunction } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type Wrap = (fn: (req: Request, res: Response, next: NextFunction) => unknown) => (req: Request, res: Response, next: NextFunction) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let _sb: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[newsletters] missing SUPABASE env');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

// is_admin() evaluated AS the caller (auth.uid() must resolve to them), the
// content-platform pattern. Returns the user id or null after responding.
async function requireAdmin(req: Request, res: Response): Promise<string | null> {
  const authHeader = req.headers.authorization;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!authHeader?.startsWith('Bearer ') || !url || !anonKey) {
    res.status(401).json({ error: { code: 'unauthorized', message: 'Missing bearer token' } });
    return null;
  }
  const asUser = createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } });
  const [{ data: isAdmin, error }, { data: u }] = await Promise.all([asUser.rpc('is_admin'), asUser.auth.getUser()]);
  if (error || isAdmin !== true || !u?.user?.id) {
    res.status(403).json({ error: { code: 'forbidden', message: 'Admin privileges required' } });
    return null;
  }
  return u.user.id;
}

/** The platform's enqueue helper from the module context (server.ts). */
export type EnqueueJob = (queue: string, name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ id: string | undefined }>;

// Through the platform's enqueueJob, not a direct bullmq import: the module
// is loaded from its own directory, where ESM import('bullmq') cannot resolve.
async function enqueue(runId: string, enqueueJob: EnqueueJob | undefined) {
  if (typeof enqueueJob !== 'function') throw new Error('no enqueueJob in the module context');
  const { id } = await enqueueJob('jobs', 'newsletters:research-run', { kind: 'newsletters:research-run', runId }, { jobId: `newsletters-research-run-${runId}`, attempts: 2, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: { count: 500 }, removeOnFail: { count: 500 } });
  if (!id) throw new Error('the jobs queue is not registered');
}

interface ResearchBlock { id: string; def_id: string; binding: Record<string, unknown> }

async function researchBlocksOf(editionId: string, onlyBlock?: string): Promise<ResearchBlock[]> {
  let q = sb()
    .from('newsletters_edition_blocks')
    .select('id, templates_block_defs!templates_block_def_id(id, source_kind, data_source)')
    .eq('edition_id', editionId)
    .is('deleted_at', null);
  if (onlyBlock) q = q.eq('id', onlyBlock);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as Array<{ id: string; templates_block_defs: { id: string; source_kind: string; data_source: Record<string, unknown> | null } | null }>)
    .filter((b) => b.templates_block_defs?.source_kind === 'research' && b.templates_block_defs.data_source)
    .map((b) => ({ id: b.id, def_id: b.templates_block_defs!.id, binding: b.templates_block_defs!.data_source! }));
}

export function registerResearchRoutes(router: Router, wrap: Wrap, enqueueJob?: EnqueueJob) {
  router.get('/newsletters/editions/:editionId/research', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const editionId = String(req.params.editionId);
    if (!UUID.test(editionId)) return void res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'invalid edition id' } });
    const blocks = await researchBlocksOf(editionId);
    const ids = blocks.map((b) => b.id);
    const runs = ids.length
      ? (await sb().from('newsletters_research_runs').select('id, block_id, status, failure_kind, triggered_by, scheduled_for, started_at, completed_at, cost_micro_usd, error, ai_thread_id, binding_hash, seq').in('block_id', ids).order('seq', { ascending: false }).limit(ids.length * 5)).data ?? []
      : [];
    const latest: Record<string, unknown> = {};
    for (const r of runs as Array<{ block_id: string }>) if (!latest[r.block_id]) latest[r.block_id] = r;
    const { data: gate } = await sb().rpc('newsletters_send_gate', { p_edition_id: editionId });
    const { data: eff } = await sb().rpc('newsletters_effective_research_at', { p_edition_id: editionId });
    const { data: open } = await sb().rpc('newsletters_edition_research_open', { p_edition_id: editionId });
    res.json({ blocks: blocks.map((b) => ({ ...b, latest_run: latest[b.id] ?? null })), gate: Array.isArray(gate) ? gate[0] : gate, effective_research_at: eff ?? null, research_open: open === true });
  }));

  router.get('/newsletters/editions/:editionId/research/runs', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const editionId = String(req.params.editionId);
    if (!UUID.test(editionId)) return void res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'invalid edition id' } });
    const { data, error } = await sb().from('newsletters_research_runs').select('id, block_id, status, failure_kind, triggered_by, scheduled_for, started_at, completed_at, cost_micro_usd, error, input_summary, ai_thread_id, seq').eq('edition_id', editionId).order('seq', { ascending: false }).limit(50);
    if (error) return void res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });
    res.json({ runs: data ?? [] });
  }));

  router.post('/newsletters/editions/:editionId/research/run', wrap(async (req, res) => {
    const user = await requireAdmin(req, res);
    if (!user) return;
    const editionId = String(req.params.editionId);
    const blockId = typeof req.body?.block_id === 'string' ? req.body.block_id : undefined;
    if (!UUID.test(editionId) || (blockId && !UUID.test(blockId))) return void res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'invalid id' } });
    const { data: ed } = await sb().from('newsletters_editions').select('status').eq('id', editionId).maybeSingle();
    if (!ed) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'edition not found' } });
    // Drafts and published editions that have not started sending (the same
    // rule newsletters_research_write applies when the run lands).
    const { data: open, error: openErr } = await sb().rpc('newsletters_edition_research_open', { p_edition_id: editionId });
    if (openErr) return void res.status(500).json({ error: { code: 'QUERY_ERROR', message: openErr.message } });
    if (open !== true) return void res.status(409).json({ error: { code: 'EDITION_NOT_OPEN', message: 'research only runs on draft or published editions that have not started sending' } });
    const blocks = await researchBlocksOf(editionId, blockId);
    if (!blocks.length) return void res.status(404).json({ error: { code: 'NO_RESEARCH_BLOCKS', message: blockId ? 'that block has no research binding' : 'this edition has no research blocks' } });
    const queued: string[] = [];
    const busy: string[] = [];
    for (const b of blocks) {
      const ins = await sb().from('newsletters_research_runs').insert({ edition_id: editionId, block_id: b.id, block_def_id: b.def_id, binding: b.binding, binding_hash: 'pending', triggered_by: 'manual', status: 'queued', created_by: user }).select('id').maybeSingle();
      if (ins.error) {
        if (/one_inflight|duplicate key/i.test(ins.error.message)) { busy.push(b.id); continue; }
        return void res.status(500).json({ error: { code: 'QUERY_ERROR', message: ins.error.message } });
      }
      const runId = (ins.data as { id: string }).id;
      try {
        await enqueue(runId, enqueueJob);
        queued.push(runId);
      } catch (e) {
        // queued → cancelled: the 093 guard refuses queued → failed, and the
        // row must leave queued so it stops holding the one-in-flight slot.
        const msg = e instanceof Error ? e.message : String(e);
        const { error: cErr } = await sb().from('newsletters_research_runs').update({ status: 'cancelled', failure_kind: 'other', error: `enqueue failed: ${msg}` }).eq('id', runId).eq('status', 'queued');
        if (cErr) console.error(`[newsletters:research] could not cancel run ${runId} after enqueue failure: ${cErr.message}`);
        return void res.status(503).json({ error: { code: 'QUEUE_UNAVAILABLE', message: 'could not queue the research run; try again shortly' } });
      }
    }
    res.json({ queued, busy });
  }));

  router.post('/newsletters/research/runs/:runId/cancel', wrap(async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const runId = String(req.params.runId);
    if (!UUID.test(runId)) return void res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'invalid run id' } });
    const { data, error } = await sb().from('newsletters_research_runs').update({ status: 'cancelled', error: 'cancelled by an admin' }).eq('id', runId).in('status', ['queued', 'running']).select('id').maybeSingle();
    if (error) return void res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });
    if (!data) return void res.status(409).json({ error: { code: 'NOT_CANCELLABLE', message: 'run is not queued or running' } });
    res.json({ cancelled: runId });
  }));

  router.post('/newsletters/research/runs/:runId/revert', wrap(async (req, res) => {
    const user = await requireAdmin(req, res);
    if (!user) return;
    const runId = String(req.params.runId);
    if (!UUID.test(runId)) return void res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'invalid run id' } });
    const { data: src } = await sb().from('newsletters_research_runs').select('id, edition_id, block_id, block_def_id, binding, binding_hash, output, status').eq('id', runId).maybeSingle();
    const s = src as { id: string; edition_id: string; block_id: string; block_def_id: string; binding: Record<string, unknown>; binding_hash: string; output: unknown; status: string } | null;
    if (!s || s.status !== 'complete' || s.output == null) return void res.status(409).json({ error: { code: 'NOT_REVERTABLE', message: 'only a completed run with output can be reverted to' } });
    const field = (s.binding?.output as { field?: string } | undefined)?.field;
    if (!field) return void res.status(409).json({ error: { code: 'NO_FIELD', message: 'run binding has no output field' } });
    const ins = await sb().from('newsletters_research_runs').insert({ edition_id: s.edition_id, block_id: s.block_id, block_def_id: s.block_def_id, binding: s.binding, binding_hash: s.binding_hash, triggered_by: 'revert', status: 'queued', created_by: user }).select('id').maybeSingle();
    if (ins.error) return void res.status(ins.error.message.match(/one_inflight|duplicate key/i) ? 409 : 500).json({ error: { code: 'QUERY_ERROR', message: ins.error.message } });
    const newId = (ins.data as { id: string }).id;
    await sb().from('newsletters_research_runs').update({ status: 'running' }).eq('id', newId);
    const { data: version, error: wErr } = await sb().rpc('newsletters_research_write', { p_block_id: s.block_id, p_field: field, p_value: s.output as never, p_run_id: newId });
    if (wErr) {
      await sb().from('newsletters_research_runs').update({ status: 'failed', failure_kind: 'other', error: wErr.message }).eq('id', newId);
      return void res.status(409).json({ error: { code: 'REVERT_FAILED', message: wErr.message } });
    }
    await sb().from('newsletters_research_runs').update({ status: 'complete', output: s.output as never, input_summary: { reverted_from: runId } }).eq('id', newId);
    res.json({ run_id: newId, version });
  }));
}
