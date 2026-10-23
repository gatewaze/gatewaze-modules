/**
 * Fill an edition's blocks from a Google Doc (or pasted HTML).
 *
 *   POST /newsletters/editions/:editionId/gdoc-fill   { google_doc_url } | { html }
 *        → { proposal, source }
 *
 * Fetches the doc, asks the model to put each section into the edition's
 * blocks, and returns the result as a PROPOSAL. Nothing is written: the
 * editor shows the proposal, the author chooses per block whether to keep
 * the current content or take the doc's, and the edition is saved through
 * the normal versioned save.
 *
 * Doc fetch: the doc must be shared as "anyone with the link can view" and
 * is read from the public export URL. Reading PRIVATE docs through a Google
 * account (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN)
 * is off unless NEWSLETTER_GDOC_USE_GOOGLE_ACCOUNT=true: that account may
 * see documents the admin asking cannot, and the proposal returns their
 * content. Every fetch logs the user and doc id. Either way the URL is
 * built from a validated doc id on a fixed Google host, and redirects are
 * followed only to Google content hosts.
 *
 * Model: the ai module's credential resolution for the use case
 * 'newsletter-gdoc-fill' (a per-use-case credential, else ANTHROPIC_API_KEY);
 * the model is that use case's default_model when the row exists.
 */

import type { Router, Request, Response, NextFunction } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { rateLimit } from '../lib/rate-limit.js';
import { stripTags } from '../lib/sanitize-inline.js';
import {
  parseGoogleDocId,
  cleanDocHtml,
  buildFillPrompt,
  validateProposal,
  splitDocSections,
  mergeProposals,
  type FillProposal,
  type FillTargetBlock,
  type FillLibraryBlock,
} from '../lib/gdoc-fill.js';
import type { SchemaFieldDef } from '../lib/schema-defaults.js';

type Wrap = (fn: (req: Request, res: Response, next: NextFunction) => unknown) => (req: Request, res: Response, next: NextFunction) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USE_CASE = 'newsletter-gdoc-fill';
const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_DOC_BYTES = 3 * 1024 * 1024;
const MAX_PASTED_CHARS = 1_500_000;
const FETCH_TIMEOUT_MS = 20_000;
const MODEL_TIMEOUT_MS = 240_000;
// Concurrent runs: each holds a model call open for up to MODEL_TIMEOUT_MS.
const MAX_RUNNING_PER_USER = 2;
const MAX_RUNNING_TOTAL = 8;
// A long draft is mapped in parts of about this many characters of cleaned
// HTML, PART_CONCURRENCY at a time. A part whose reply still runs out of
// room is halved and retried, at most MAX_SPLIT_DEPTH times.
const PART_CHARS = 9_000;
const PART_CONCURRENCY = 4;
const MAX_SPLIT_DEPTH = 2;
let lastHousekeeping = 0;

let _sb: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[newsletters] missing SUPABASE env');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

/** is_admin() as the caller (a JWT alone is any signed-in portal member). */
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

class UserFacingError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'gdoc_fill_failed') { super(message); }
}

// ---------------------------------------------------------------------------
// Google Doc fetch
// ---------------------------------------------------------------------------

function googleOAuthEnv(): { clientId: string; clientSecret: string; refreshToken: string } | null {
  if (process.env.NEWSLETTER_GDOC_USE_GOOGLE_ACCOUNT !== 'true') return null;
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_SHEETS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_SHEETS_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN || process.env.GOOGLE_SHEETS_REFRESH_TOKEN;
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;
}

async function readCapped(r: globalThis.Response): Promise<string> {
  const len = Number(r.headers.get('content-length') ?? '0');
  if (len > MAX_DOC_BYTES) throw new UserFacingError('The document is too large to import (over 3 MB).');
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_DOC_BYTES) throw new UserFacingError('The document is too large to import (over 3 MB).');
  return new TextDecoder().decode(buf);
}

/** Redirect targets we follow from the public export: Google's own content hosts only. */
function isAllowedRedirect(loc: URL): boolean {
  return loc.protocol === 'https:' && (loc.hostname === 'docs.google.com' || loc.hostname.endsWith('.googleusercontent.com'));
}

export async function fetchGoogleDocHtml(docId: string): Promise<string> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const oauth = googleOAuthEnv();
  if (oauth) {
    const tok = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: oauth.clientId, client_secret: oauth.clientSecret, refresh_token: oauth.refreshToken, grant_type: 'refresh_token' }),
      signal,
    });
    if (tok.ok) {
      const { access_token } = (await tok.json()) as { access_token?: string };
      if (access_token) {
        const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(docId)}/export?mimeType=text%2Fhtml`, {
          headers: { Authorization: `Bearer ${access_token}` },
          signal,
        });
        if (r.ok) return readCapped(r);
        if (r.status !== 403 && r.status !== 404) throw new UserFacingError(`Google Drive returned ${r.status} for that document.`, 502);
        // 403/404 with our account: fall through to the public export.
      }
    }
  }
  let url = new URL(`https://docs.google.com/document/d/${encodeURIComponent(docId)}/export?format=html`);
  for (let hop = 0; hop < 4; hop++) {
    const r = await fetch(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'Gatewaze newsletter import' } });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) break;
      const next = new URL(loc, url);
      if (next.hostname === 'accounts.google.com') {
        throw new UserFacingError('That document is not shared publicly. In Google Docs choose Share → General access → "Anyone with the link" (Viewer), then try again.', 403, 'doc_not_shared');
      }
      if (!isAllowedRedirect(next)) break;
      url = next;
      continue;
    }
    if (r.status === 404) throw new UserFacingError('Google could not find that document. Check the link.', 404, 'doc_not_found');
    if (!r.ok) throw new UserFacingError(`Google returned ${r.status} for that document.`, 502);
    const html = await readCapped(r);
    if (/<title>[^<]*Sign in/i.test(html)) {
      throw new UserFacingError('That document is not shared publicly. In Google Docs choose Share → General access → "Anyone with the link" (Viewer), then try again.', 403, 'doc_not_shared');
    }
    return html;
  }
  throw new UserFacingError('Could not read that document from Google.', 502);
}

// ---------------------------------------------------------------------------
// Model call
// ---------------------------------------------------------------------------

/**
 * Copying a draft into block fields is mechanical, so thinking only adds time
 * and output tokens (on claude-sonnet-5 it was over half of each reply).
 * Models that accept it get thinking switched off; the rest, whose thinking
 * cannot be disabled, get the lowest effort.
 */
export function reasoningOptions(model: string): Record<string, unknown> {
  if (/^claude-(sonnet-5|opus-5|opus-4-[78])$/.test(model)) {
    return { thinking: { type: 'disabled' } };
  }
  if (/^claude-(opus-5-5|sonnet-5-5|haiku-5-5|fable-5)/.test(model)) {
    return { output_config: { effort: 'low' } };
  }
  return {};
}

async function callModel(prompt: string, userId: string): Promise<{ text: string; usage: { input: number; output: number }; model: string }> {
  const { data: uc } = await sb().from('ai_use_cases').select('default_model, max_output_tokens').eq('id', USE_CASE).maybeSingle();
  const model = (uc as { default_model?: string } | null)?.default_model || DEFAULT_MODEL;
  const maxTokens = Math.min(Math.max((uc as { max_output_tokens?: number } | null)?.max_output_tokens ?? 16000, 4000), 32000);

  let apiKey: string | null = null;
  let kind: 'api_key' | 'claude_subscription' = 'api_key';
  try {
    const { resolveCredential } = await import('../../ai/lib/credentials.js');
    const cred = await resolveCredential(sb() as never, { provider: 'anthropic', userId, useCase: USE_CASE });
    apiKey = cred.apiKey;
    kind = cred.kind;
  } catch (err) {
    // ai module not installed here: the environment key, if any.
    // eslint-disable-next-line no-console
    console.warn('[newsletters] gdoc-fill credential lookup failed; using ANTHROPIC_API_KEY:', err instanceof Error ? err.message : err);
    apiKey = process.env.ANTHROPIC_API_KEY ?? null;
  }
  if (!apiKey) throw new UserFacingError('No AI credential is configured for newsletter imports.', 503, 'no_ai_credential');

  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  if (kind === 'claude_subscription') {
    headers.authorization = `Bearer ${apiKey}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  } else {
    headers['x-api-key'] = apiKey;
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, max_tokens: maxTokens, ...reasoningOptions(model), messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    // eslint-disable-next-line no-console
    console.warn(`[newsletters] gdoc-fill model call failed: ${r.status} ${body.slice(0, 300)}`);
    throw new UserFacingError(r.status === 401 || r.status === 403
      ? 'The AI credential for newsletter imports was refused. Ask an admin to check it.'
      : `The AI service returned ${r.status}. Try again in a minute.`, 502, 'ai_failed');
  }
  const json = (await r.json()) as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number }; stop_reason?: string };
  if (json.stop_reason === 'max_tokens') {
    throw new UserFacingError('A section of the document is too long to map. Split it into smaller sections, or paste a shorter part.', 422, 'too_long');
  }
  const text = (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  return { text, usage: { input: json.usage?.input_tokens ?? 0, output: json.usage?.output_tokens ?? 0 }, model };
}

// ---------------------------------------------------------------------------
// Edition shape
// ---------------------------------------------------------------------------

interface DefRow {
  key: string;
  name: string | null;
  description: string | null;
  schema: Record<string, SchemaFieldDef> | null;
  source_kind: string | null;
  data_source: { output?: { field?: string } } | null;
}

async function loadTargets(editionId: string): Promise<{ blocks: FillTargetBlock[]; library: FillLibraryBlock[] }> {
  const { data: ed, error } = await sb().from('newsletters_editions').select('id, collection_id').eq('id', editionId).maybeSingle();
  if (error || !ed) throw new UserFacingError('Edition not found.', 404, 'not_found');
  const [{ data: rows }, { data: defs }] = await Promise.all([
    sb().from('newsletters_edition_blocks')
      .select('id, block_type, sort_order, def:templates_block_defs!templates_block_def_id(key, name, description, schema, source_kind, data_source)')
      .eq('edition_id', editionId).is('deleted_at', null).order('sort_order'),
    sb().from('templates_block_defs')
      .select('key, name, description, schema, source_kind, data_source')
      .eq('library_id', (ed as { collection_id: string }).collection_id).eq('is_current', true).order('key'),
  ]);
  const blocks: FillTargetBlock[] = ((rows ?? []) as Array<{ id: string; block_type: string; def: DefRow | null }>)
    .filter((r) => r.def && r.def.schema && Object.keys(r.def.schema).length > 0)
    .map((r) => ({
      id: r.id,
      block_type: r.block_type,
      name: r.def!.name || r.block_type,
      description: r.def!.description,
      schema: r.def!.schema!,
      research_field: r.def!.source_kind === 'research' ? r.def!.data_source?.output?.field ?? null : null,
    }));
  const library: FillLibraryBlock[] = ((defs ?? []) as DefRow[])
    .filter((d) => d.schema && Object.keys(d.schema).length > 0 && d.source_kind !== 'research')
    .map((d) => ({ block_type: d.key, name: d.name || d.key, description: d.description, schema: d.schema! }));
  return { blocks, library };
}

/** Do the work for one job and record the outcome on its row. Never throws. */
async function runJob(jobId: string, editionId: string, userId: string, input: { html: string } | { docId: string }): Promise<void> {
  const finish = async (patch: Record<string, unknown>) => {
    await sb().from('newsletters_gdoc_fill_jobs').update({ ...patch, completed_at: new Date().toISOString() }).eq('id', jobId);
  };
  try {
    // eslint-disable-next-line no-console
    console.log(`[newsletters] gdoc-fill job=${jobId} user=${userId} edition=${editionId} source=${'html' in input ? 'pasted-html' : `google-doc:${input.docId}`}`);
    const rawHtml = 'html' in input ? input.html : await fetchGoogleDocHtml(input.docId);
    const docHtml = cleanDocHtml(rawHtml);
    if (stripTags(docHtml).trim().length < 20) throw new UserFacingError('The document looks empty.', 422, 'empty_doc');
    const { blocks, library } = await loadTargets(editionId);
    if (blocks.length === 0 && library.length === 0) {
      throw new UserFacingError('This newsletter has no template blocks to fill.', 422, 'no_blocks');
    }
    const started = Date.now();
    const usage = { input: 0, output: 0 };
    let model = '';
    // Map one part; a reply that runs out of room is halved and retried.
    const mapPart = async (html: string, part: { index: number; total: number }, depth: number): Promise<FillProposal[]> => {
      try {
        const r = await callModel(buildFillPrompt({ docHtml: html, blocks, library, part }), userId);
        usage.input += r.usage.input;
        usage.output += r.usage.output;
        model = r.model;
        try {
          return [validateProposal(r.text, blocks, library)];
        } catch {
          throw new UserFacingError('The AI reply could not be read. Try again.', 502, 'bad_ai_reply');
        }
      } catch (err) {
        if (err instanceof UserFacingError && err.code === 'too_long' && depth < MAX_SPLIT_DEPTH) {
          const halves = splitDocSections(html, Math.ceil(html.length / 2) + 200);
          if (halves.length > 1) {
            const out: FillProposal[] = [];
            for (const h of halves) out.push(...(await mapPart(h, part, depth + 1)));
            return out;
          }
        }
        throw err;
      }
    };
    const parts = splitDocSections(docHtml, PART_CHARS);
    const results: FillProposal[][] = new Array(parts.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, parts.length) }, async () => {
      while (next < parts.length) {
        const i = next++;
        results[i] = await mapPart(parts[i], { index: i + 1, total: parts.length }, 0);
      }
    }));
    const proposal = mergeProposals(results.flat());
    // eslint-disable-next-line no-console
    console.log(`[newsletters] gdoc-fill job=${jobId} edition=${editionId} parts=${parts.length} blocks=${proposal.blocks.length} unmapped=${proposal.unmapped.length} model=${model} tokens=${usage.input}/${usage.output} ms=${Date.now() - started}`);
    await finish({ status: 'complete', proposal, usage: { ...usage, model, parts: parts.length } });
  } catch (err) {
    const timedOut = (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
    const known = err instanceof UserFacingError;
    if (!known && !timedOut) {
      // eslint-disable-next-line no-console
      console.error('[newsletters] gdoc-fill job failed:', err);
    }
    await finish({
      status: 'failed',
      error_code: known ? err.code : timedOut ? 'timeout' : 'internal_error',
      error: known ? err.message : timedOut ? 'Reading or mapping the document took too long. Try again.' : 'Something went wrong while reading the document.',
    }).catch(() => undefined);
  }
}

export function registerGdocFillRoutes(router: Router, wrap: Wrap): void {
  // Start a run. Replies at once with the job id; the work happens after.
  router.post('/newsletters/editions/:editionId/gdoc-fill', wrap(async (req, res) => {
    const userId = await requireAdmin(req, res);
    if (!userId) return;
    const editionId = req.params.editionId;
    if (!UUID.test(editionId)) { res.status(400).json({ error: { code: 'bad_id', message: 'Invalid edition id' } }); return; }
    // Each run spends model tokens: a few a minute per person is plenty.
    if (!rateLimit(`nl-gdoc-fill:${userId}`, 4, 60_000)) {
      res.status(429).json({ error: { code: 'rate_limited', message: 'Please wait a minute before processing another document.' } });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    let input: { html: string } | { docId: string };
    let source: Record<string, unknown>;
    if (typeof body.html === 'string' && body.html.trim()) {
      if (body.html.length > MAX_PASTED_CHARS) {
        res.status(400).json({ error: { code: 'too_large', message: 'The pasted HTML is too large (over 1.5 MB).' } });
        return;
      }
      input = { html: body.html };
      source = { kind: 'html' };
    } else {
      const docId = typeof body.google_doc_url === 'string' ? parseGoogleDocId(body.google_doc_url) : null;
      if (!docId) {
        res.status(400).json({ error: { code: 'bad_doc_url', message: 'Paste the link to a Google Doc (https://docs.google.com/document/d/…).' } });
        return;
      }
      input = { docId };
      source = { kind: 'google_doc', doc_id: docId };
    }
    const { data: ed } = await sb().from('newsletters_editions').select('id').eq('id', editionId).maybeSingle();
    if (!ed) { res.status(404).json({ error: { code: 'not_found', message: 'Edition not found' } }); return; }

    // Running jobs older than 10 minutes are dead (an api restart); they do not count.
    const liveSince = new Date(Date.now() - 10 * 60_000).toISOString();
    const [{ count: mine }, { count: all }] = await Promise.all([
      sb().from('newsletters_gdoc_fill_jobs').select('id', { count: 'exact', head: true }).eq('status', 'running').eq('requested_by', userId).gte('created_at', liveSince),
      sb().from('newsletters_gdoc_fill_jobs').select('id', { count: 'exact', head: true }).eq('status', 'running').gte('created_at', liveSince),
    ]);
    if ((mine ?? 0) >= MAX_RUNNING_PER_USER || (all ?? 0) >= MAX_RUNNING_TOTAL) {
      res.status(429).json({ error: { code: 'busy', message: 'Other documents are still being processed. Try again in a minute.' } });
      return;
    }
    // Housekeeping, at most hourly: proposals are only useful for a few minutes.
    if (Date.now() - lastHousekeeping > 3_600_000) {
      lastHousekeeping = Date.now();
      void sb().from('newsletters_gdoc_fill_jobs').delete().lt('created_at', new Date(Date.now() - 7 * 86_400_000).toISOString());
    }
    const { data: job, error } = await sb().from('newsletters_gdoc_fill_jobs')
      .insert({ edition_id: editionId, requested_by: userId, source, status: 'running' })
      .select('id').single();
    if (error || !job) { res.status(500).json({ error: { code: 'job_insert_failed', message: error?.message ?? 'Could not start the import' } }); return; }
    res.status(202).json({ job_id: (job as { id: string }).id });
    void runJob((job as { id: string }).id, editionId, userId, input);
  }));

  // Poll a run. Only the person who started it can read it.
  router.get('/newsletters/gdoc-fill/jobs/:jobId', wrap(async (req, res) => {
    const userId = await requireAdmin(req, res);
    if (!userId) return;
    const jobId = req.params.jobId;
    if (!UUID.test(jobId)) { res.status(400).json({ error: { code: 'bad_id', message: 'Invalid job id' } }); return; }
    const { data } = await sb().from('newsletters_gdoc_fill_jobs')
      .select('id, edition_id, status, proposal, error_code, error, usage, created_at, completed_at, requested_by')
      .eq('id', jobId).maybeSingle();
    const row = data as { requested_by: string; status: string; created_at: string } | null;
    if (!row || row.requested_by !== userId) { res.status(404).json({ error: { code: 'not_found', message: 'Import not found' } }); return; }
    // A run that never finished (the api restarted mid-way) reads as failed.
    if (row.status === 'running' && Date.now() - Date.parse(row.created_at) > 10 * 60_000) {
      res.json({ ...row, requested_by: undefined, status: 'failed', error_code: 'timeout', error: 'The import did not finish. Try again.' });
      return;
    }
    res.json({ ...row, requested_by: undefined });
  }));
}
