/**
 * Privacy request service shared by the admin routes, the public API
 * (/api/v1/privacy) and the worker.
 *
 * No third-party imports: the API container does not install a module's own
 * npm dependencies, so anything the route registration imports must stay
 * dependency-free. The Supabase client and the job enqueuer are passed in.
 */

import { createHash } from 'node:crypto';

/** Same normalisation as the SQL compliance_email_sha256(). */
export function emailSha256(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

export const REQUEST_TYPES = [
  'data_deletion',
  'data_export',
  'data_correction',
  'data_portability',
  'consent_withdrawal',
  'processing_restriction',
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const MAX_EMAILS = 10;
/** A preview older than this must be rebuilt before an erasure can run. */
export const PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const ERASURE_JOB = 'compliance:erasure';

const EMAIL_RE = /^[^\s@,;<>()"']{1,64}@[^\s@,;<>()"']{1,255}\.[A-Za-z0-9-]{2,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Via = 'admin' | 'api' | 'mcp';
export interface Actor {
  via: Via;
  /** Stable label stored on the request: admin user id, API key name, or MCP person id. */
  label: string;
}

export class PrivacyError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supabase = any;
type Enqueue = (queue: string, name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ id: string | undefined }>;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function actorLabel(actor: Actor): string {
  return `${actor.via}:${actor.label}`.slice(0, 200);
}

/** Lowercase, trim, dedupe and validate. Accepts a string or an array. */
export function normaliseEmails(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,;]+/) : [];
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const e = v.trim().toLowerCase();
    if (!e) continue;
    if (e.length > 320 || !EMAIL_RE.test(e)) {
      // Don't echo the input: it is usually a typo of a real address.
      throw new PrivacyError(400, 'VALIDATION_ERROR', 'one of the email addresses is not valid');
    }
    out.add(e);
  }
  if (out.size === 0) throw new PrivacyError(400, 'VALIDATION_ERROR', 'at least one email is required');
  if (out.size > MAX_EMAILS) throw new PrivacyError(400, 'VALIDATION_ERROR', `at most ${MAX_EMAILS} emails per request`);
  return [...out];
}

function optionalText(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new PrivacyError(400, 'VALIDATION_ERROR', `${field} must be a string`);
  return v.trim().slice(0, max) || null;
}

function parseDueAt(v: unknown, requestedAt: Date): string {
  if (v === undefined || v === null || v === '') {
    // GDPR Art. 12(3): one month from receipt.
    const d = new Date(requestedAt);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString();
  }
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new PrivacyError(400, 'VALIDATION_ERROR', 'due_at must be an ISO date');
  return d.toISOString();
}

export interface CreateInput {
  emails: string[];
  request_type: RequestType;
  source: string | null;
  notes: string | null;
  requester_email: string | null;
  requested_at: string;
  due_at: string;
}

/** Allowlist of writable fields. Anything else in the body is ignored. */
export function parseCreateInput(body: unknown): CreateInput {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const emails = normaliseEmails(b.emails ?? b.email);
  const type = (b.request_type ?? 'data_deletion') as string;
  if (!(REQUEST_TYPES as readonly string[]).includes(type)) {
    throw new PrivacyError(400, 'VALIDATION_ERROR', `request_type must be one of ${REQUEST_TYPES.join(', ')}`);
  }
  let requestedAt = new Date();
  if (b.requested_at) {
    const d = new Date(String(b.requested_at));
    if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 60_000) {
      throw new PrivacyError(400, 'VALIDATION_ERROR', 'requested_at must be an ISO date, not in the future');
    }
    requestedAt = d;
  }
  const requester = b.requester_email ? normaliseEmails(b.requester_email)[0] : null;
  return {
    emails,
    request_type: type as RequestType,
    source: optionalText(b.source, 'source', 500),
    notes: optionalText(b.notes, 'notes', 5000),
    requester_email: requester,
    requested_at: requestedAt.toISOString(),
    due_at: parseDueAt(b.due_at, requestedAt),
  };
}

const COLUMNS =
  'id, request_type, status, subject_email, subject_emails, subject_email_sha256, source, notes, ' +
  'requested_at, due_at, submitted_via, submitted_by, requester_email, plan, plan_status, plan_error, ' +
  'plan_built_at, previewed_by, execute_status, executed_by, executed_at, report, processors, checklist, ' +
  'identifiers, error_message, processing_completed_at, processors_ran_at, redacted_at, created_at, updated_at';

/**
 * Wake the worker. The request row is the source of truth (plan_status /
 * execute_status = 'queued'); a one-minute sweep in the worker picks up
 * anything this misses, e.g. on hosts where the public API has no queue.
 */
async function kick(enqueue: Enqueue | undefined, action: string, id: string, actor: Actor) {
  if (!enqueue) return;
  try {
    await enqueue('jobs', ERASURE_JOB, { kind: ERASURE_JOB, action, requestId: id, actor: actorLabel(actor) }, { attempts: 1 });
  } catch (e) {
    console.warn(`[compliance] could not enqueue ${action} for ${id}; the sweep will pick it up`, e);
  }
}

export async function createRequest(supabase: Supabase, input: CreateInput, actor: Actor) {
  const { data, error } = await supabase
    .from('compliance_privacy_requests')
    .insert({
      subject_email: input.emails[0],
      subject_emails: input.emails,
      request_type: input.request_type,
      status: 'pending',
      requested_at: input.requested_at,
      due_at: input.due_at,
      source: input.source,
      notes: input.notes,
      requester_email: input.requester_email ?? input.emails[0],
      submitted_via: actor.via,
      submitted_by: actorLabel(actor),
    })
    .select(COLUMNS)
    .single();
  if (error) throw new PrivacyError(500, 'QUERY_ERROR', error.message);
  return data;
}

export async function getRequest(supabase: Supabase, id: string) {
  if (!isUuid(id)) throw new PrivacyError(400, 'VALIDATION_ERROR', 'id must be a uuid');
  const { data, error } = await supabase.from('compliance_privacy_requests').select(COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new PrivacyError(500, 'QUERY_ERROR', error.message);
  if (!data) throw new PrivacyError(404, 'NOT_FOUND', 'privacy request not found');
  return data;
}

/** Requests for an email, matched exactly (by hash once a request is redacted). */
export async function findByEmail(supabase: Supabase, email: string, sha256: string) {
  // Two plain filters rather than one .or() string, so the address never
  // becomes part of a PostgREST filter expression.
  const [open, redacted] = await Promise.all([
    supabase.from('compliance_privacy_requests').select(COLUMNS)
      .contains('subject_emails', [email]).order('requested_at', { ascending: false }).limit(20),
    supabase.from('compliance_privacy_requests').select(COLUMNS)
      .contains('subject_email_sha256', [sha256]).order('requested_at', { ascending: false }).limit(20),
  ]);
  const error = open.error ?? redacted.error;
  if (error) throw new PrivacyError(500, 'QUERY_ERROR', error.message);
  const byId = new Map<string, Record<string, unknown>>();
  for (const r of [...(open.data ?? []), ...(redacted.data ?? [])]) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at)));
}

export async function queuePreview(supabase: Supabase, enqueue: Enqueue | undefined, id: string, actor: Actor) {
  const row = await getRequest(supabase, id);
  if (row.request_type !== 'data_deletion') {
    throw new PrivacyError(409, 'UNSUPPORTED', 'previews are only available for data_deletion requests');
  }
  if (row.executed_at || row.redacted_at || row.status === 'completed' || row.status === 'rejected') {
    throw new PrivacyError(409, 'CLOSED', 'this request has already been carried out or closed');
  }
  if (row.plan_status === 'queued' || row.plan_status === 'running') return row;
  const { error } = await supabase
    .from('compliance_privacy_requests')
    .update({ plan_status: 'queued', plan_error: null, previewed_by: actorLabel(actor) })
    .eq('id', id);
  if (error) throw new PrivacyError(500, 'QUERY_ERROR', error.message);
  await kick(enqueue, 'preview', id, actor);
  return getRequest(supabase, id);
}

/**
 * Queue the erasure. The caller must type one of the request's addresses as
 * confirmation. Refuses if the preview is missing, stale or has blockers.
 * The state change is a compare-and-set so two clicks can't queue it twice.
 */
export async function queueExecute(supabase: Supabase, enqueue: Enqueue | undefined, id: string, confirmEmail: unknown, actor: Actor) {
  const row = await getRequest(supabase, id);
  if (row.request_type !== 'data_deletion') {
    throw new PrivacyError(409, 'UNSUPPORTED', 'erasure is only available for data_deletion requests');
  }
  if (row.executed_at || row.execute_status === 'erased') {
    throw new PrivacyError(409, 'ALREADY_ERASED', 'this request has already been erased');
  }
  const confirm = typeof confirmEmail === 'string' ? confirmEmail.trim().toLowerCase() : '';
  if (!confirm || !(row.subject_emails ?? [row.subject_email]).includes(confirm)) {
    throw new PrivacyError(400, 'CONFIRMATION_REQUIRED', 'confirm_email must match one of the request addresses');
  }
  if (row.plan_status !== 'ready' || !row.plan) {
    throw new PrivacyError(409, 'PREVIEW_REQUIRED', 'run a preview first');
  }
  if (!row.plan_built_at || Date.now() - new Date(row.plan_built_at).getTime() > PLAN_MAX_AGE_MS) {
    throw new PrivacyError(409, 'PREVIEW_STALE', 'the preview is more than 24 hours old; run it again');
  }
  if ((row.plan.blockers ?? []).length > 0) {
    throw new PrivacyError(409, 'BLOCKED', 'the preview has blockers; resolve them and preview again');
  }
  // Matching more than one person record needs a human to check they are
  // the same person, so only an admin, looking at the addresses, can go on.
  if (actor.via !== 'admin' && (row.plan.warnings ?? []).some((w: { kind?: string }) => w.kind === 'multiple_people')) {
    throw new PrivacyError(409, 'NEEDS_ADMIN_REVIEW', 'the preview matched more than one person record; an admin must review and run this erasure');
  }
  const { data: claimed, error } = await supabase
    .from('compliance_privacy_requests')
    .update({ execute_status: 'queued', error_message: null, executed_by: actorLabel(actor) })
    .eq('id', id)
    .in('execute_status', ['none', 'failed'])
    .select('id');
  if (error) throw new PrivacyError(500, 'QUERY_ERROR', error.message);
  if (!claimed || claimed.length === 0) {
    throw new PrivacyError(409, 'IN_PROGRESS', 'an erasure for this request is already queued or running');
  }
  await kick(enqueue, 'execute', id, actor);
  return getRequest(supabase, id);
}

/** Status changes for request types the engine doesn't carry out (export, correction, ...). */
export async function setManualStatus(supabase: Supabase, id: string, status: unknown) {
  const allowed = ['pending', 'in_progress', 'completed', 'rejected'];
  if (typeof status !== 'string' || !allowed.includes(status)) {
    throw new PrivacyError(400, 'VALIDATION_ERROR', `status must be one of ${allowed.join(', ')}`);
  }
  const row = await getRequest(supabase, id);
  if (row.request_type === 'data_deletion' && status !== 'rejected') {
    throw new PrivacyError(409, 'UNSUPPORTED', 'erasure requests move through preview and erase; they can only be rejected by hand');
  }
  if (row.executed_at) throw new PrivacyError(409, 'CLOSED', 'this request has already been erased');
  const fields: Record<string, unknown> = { status };
  if (status === 'completed') fields.processing_completed_at = new Date().toISOString();
  if (status === 'in_progress') fields.processing_started_at = new Date().toISOString();
  const { error } = await supabase.from('compliance_privacy_requests').update(fields).eq('id', id);
  if (error) throw new PrivacyError(500, 'QUERY_ERROR', error.message);
  return getRequest(supabase, id);
}

export async function queueProcessorRetry(supabase: Supabase, enqueue: Enqueue | undefined, id: string, actor: Actor) {
  const row = await getRequest(supabase, id);
  if (row.execute_status !== 'erased') throw new PrivacyError(409, 'NOT_ERASED', 'the database erasure has not run yet');
  if (row.redacted_at) throw new PrivacyError(409, 'CLOSED', 'this request is complete');
  if (!enqueue) throw new PrivacyError(503, 'UNAVAILABLE', 'the job queue is not available on this host');
  await kick(enqueue, 'processors', id, actor);
  return row;
}

/** Tick or untick a manual checklist item; completes the request when nothing is left. */
export async function setChecklistItem(supabase: Supabase, enqueue: Enqueue | undefined, id: string, itemId: string, done: boolean, actor: Actor) {
  const row = await getRequest(supabase, id);
  if (row.redacted_at) throw new PrivacyError(409, 'CLOSED', 'this request is complete');
  const items = Array.isArray(row.checklist) ? row.checklist : [];
  const idx = items.findIndex((i: { id: string }) => i.id === itemId);
  if (idx < 0) throw new PrivacyError(404, 'NOT_FOUND', 'checklist item not found');
  items[idx] = { ...items[idx], done, done_by: done ? actorLabel(actor) : null, done_at: done ? new Date().toISOString() : null };
  const { error } = await supabase.from('compliance_privacy_requests').update({ checklist: items }).eq('id', id);
  if (error) throw new PrivacyError(500, 'QUERY_ERROR', error.message);
  if (row.execute_status === 'erased') {
    // The worker decides whether everything is done and, if so, completes and
    // redacts. The sweep also finalizes, so a missing queue only delays it.
    await kick(enqueue, 'finalize', id, actor);
  }
  return getRequest(supabase, id);
}

interface PlanTable { table: string; entry: string; action: string; rows: number; retain?: { reason: string; basis: string; period: string } | null; note?: string | null }

/**
 * What callers outside the admin see. Discovered aliases and internal ids are
 * reduced to counts; the plan shows table names and row counts, never rows.
 */
export function publicView(row: Record<string, any>) {
  const ident = row.identifiers ?? null;
  const counts = ident
    ? {
        emails: Array.isArray(ident.emails) ? ident.emails.length : ident.emails ?? 0,
        people: Array.isArray(ident.person_ids) ? ident.person_ids.length : ident.people ?? 0,
        auth_users: Array.isArray(ident.auth_user_ids) ? ident.auth_user_ids.length : ident.auth_users ?? 0,
      }
    : null;
  return {
    id: row.id,
    request_type: row.request_type,
    status: row.status,
    emails: row.redacted_at ? null : row.subject_emails ?? [row.subject_email],
    requested_at: row.requested_at,
    due_at: row.due_at,
    source: row.source,
    submitted_via: row.submitted_via,
    preview: {
      status: row.plan_status,
      error: row.plan_status === 'failed' ? 'The preview failed. An admin can see the details.' : null,
      built_at: row.plan_built_at,
      identifiers: counts,
      summary: row.plan?.summary ?? null,
      tables: (row.plan?.tables ?? []).map((t: PlanTable) => ({ table: t.table, action: t.action, rows: t.rows, retain: t.retain ?? null })),
      blockers: row.plan?.blockers ?? [],
      warnings: row.plan?.warnings ?? [],
    },
    erasure: {
      status: row.execute_status,
      executed_at: row.executed_at,
      // Raw database errors can quote key values; admins see them in the UI.
      error: row.execute_status === 'failed' ? 'The erasure failed and was rolled back. An admin can see the details.' : null,
    },
    processors: row.processors ?? [],
    checklist: row.checklist ?? [],
    completed_at: row.processing_completed_at,
    redacted_at: row.redacted_at,
  };
}

/** Plain-language report for the reply to the data subject. */
export function reportMarkdown(row: Record<string, any>): string {
  const lines: string[] = [];
  const report = row.report ?? {};
  const db: PlanTable[] = report.database ?? [];
  const retained = db.filter((t) => t.retain);
  lines.push(`# Erasure report`, '');
  lines.push(`- Request: ${row.id}`);
  lines.push(`- Type: ${row.request_type}`);
  lines.push(`- Received: ${row.requested_at}`);
  if (row.due_at) lines.push(`- Due: ${row.due_at}`);
  lines.push(`- Status: ${row.status}`);
  if (row.executed_at) lines.push(`- Database erasure: ${row.executed_at}`);
  if (row.processing_completed_at) lines.push(`- Completed: ${row.processing_completed_at}`);
  lines.push('');

  lines.push('## What was erased', '');
  if (db.length === 0) {
    lines.push('Nothing has been erased yet.');
  } else {
    lines.push('| Table | Action | Rows |', '|---|---|---|');
    for (const t of db) lines.push(`| ${t.table}${t.entry && t.entry !== 'default' ? ` (${t.entry})` : ''} | ${t.action === 'delete' ? 'deleted' : 'identifiers removed'} | ${t.rows} |`);
    lines.push('');
    lines.push('"Identifiers removed" means the row was kept for totals or records, with the email address, name, IP address, device details and message content cleared.');
  }
  lines.push('');

  lines.push('## Outside services', '');
  const procs: Array<{ name: string; status: string; detail?: string }> = row.processors ?? [];
  if (procs.length === 0) lines.push('None processed yet.');
  for (const p of procs) lines.push(`- ${p.name}: ${p.status}${p.detail ? `. ${p.detail}` : ''}`);
  lines.push('');

  const checklist: Array<{ title: string; detail?: string; done: boolean; done_at?: string }> = row.checklist ?? [];
  if (checklist.length) {
    lines.push('## Manual steps', '');
    for (const c of checklist) lines.push(`- [${c.done ? 'x' : ' '}] ${c.title}${c.detail ? `. ${c.detail}` : ''}${c.done_at ? ` (done ${c.done_at})` : ''}`);
    lines.push('');
  }

  lines.push('## What was kept, and why', '');
  lines.push('- A sha256 hash of each erased email address, with no other data, used only to stop the address being subscribed or emailed again. The address itself is not stored.');
  lines.push('- This request record, with the addresses replaced by their hashes, as the record that the request was handled (GDPR Art. 5(2)).');
  for (const t of retained) {
    lines.push(`- ${t.table}: ${t.retain!.reason}. Basis: ${t.retain!.basis}. Period: ${t.retain!.period}`);
  }
  lines.push('- Database backups taken before the erasure keep the old data until they expire under the hosting provider\'s backup retention. They are not restored except for disaster recovery, and the erasure is re-applied after any restore.');
  lines.push('');
  return lines.join('\n');
}
