/**
 * Admin API for edition approval (migration 096). Mounted on the newsletters
 * admin router (/api/admin/...), behind requireJwt.
 *
 *   POST /newsletters/editions/:editionId/approval/request  { note?, admin_origin? }
 *        Ask the publication's approvers to approve this edition, and email
 *        them a link to the approval view.
 *   POST /newsletters/editions/:editionId/approval/decide   { decision, expected_version, note?, admin_origin? }
 *        An approver approves or asks for changes; the requester is emailed.
 *
 * Every rule (who may request, who may decide, the version check) lives in
 * the SECURITY DEFINER functions, called here AS THE CALLER so auth.uid() is
 * theirs. This file only adds the emails, which the database cannot send.
 * A failed email does not undo the request or decision; the response says
 * which addresses were not reached.
 */

import type { Router, Request, Response, NextFunction } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { rateLimit } from '../lib/rate-limit.js';

type Wrap = (fn: (req: Request, res: Response, next: NextFunction) => unknown) => (req: Request, res: Response, next: NextFunction) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE = 2000;

let _sb: SupabaseClient | null = null;
function serviceClient(): SupabaseClient {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[newsletters] missing SUPABASE env');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

/** A Supabase client that acts as the caller, so auth.uid() in the RPCs is theirs. */
function callerClient(req: Request): SupabaseClient | null {
  const authHeader = req.headers.authorization;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!authHeader?.startsWith('Bearer ') || !url || !anonKey) return null;
  return createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The admin origin the email links point at: ADMIN_URL (the deployment's
 * admin address). The request's Origin header is caller-controlled (any
 * admin can send one from a script), so it is used only when it is a local
 * development host, where no email is sent anyway. Without ADMIN_URL a
 * deployed instance refuses rather than email a link to an address the
 * caller chose.
 */
export function resolveAdminOrigin(envUrl: string | undefined, originHeader: string | undefined, claimed: unknown): string | null {
  const parse = (v: unknown): string | null => {
    if (typeof v !== 'string' || v.length > 200) return null;
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      if (u.username || u.password) return null;
      return u.origin;
    } catch {
      return null;
    }
  };
  const fromEnv = parse(envUrl);
  if (fromEnv) return fromEnv;
  const header = parse(originHeader);
  if (!header || !isLocalOrigin(header)) return null;
  const claim = parse(claimed);
  if (claim && claim !== header) return null;
  return header;
}

function cleanNote(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, MAX_NOTE) : null;
}

interface EditionInfo {
  id: string;
  title: string | null;
  edition_date: string | null;
  collection: { name: string | null; slug: string | null } | null;
}

async function loadEdition(editionId: string): Promise<EditionInfo | null> {
  const { data } = await serviceClient()
    .from('newsletters_editions')
    .select('id, title, edition_date, collection:newsletters_template_collections!collection_id(name, slug)')
    .eq('id', editionId)
    .maybeSingle();
  return (data as unknown as EditionInfo | null) ?? null;
}

async function callerName(userId: string | null): Promise<string> {
  if (!userId) return 'Someone';
  const { data } = await serviceClient().from('admin_profiles').select('name, email').eq('user_id', userId).maybeSingle();
  const row = data as { name?: string | null; email?: string | null } | null;
  return row?.name?.trim() || row?.email || 'Someone';
}

function emailHtml(heading: string, lines: string[], note: string | null, cta: { label: string; url: string }): string {
  const para = (t: string) => `<p style="margin:0 0 12px;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2937">${t}</p>`;
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;padding:28px">
<h1 style="margin:0 0 16px;font:600 20px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111827">${escapeHtml(heading)}</h1>
${lines.map(para).join('\n')}
${note ? `<blockquote style="margin:0 0 16px;padding:10px 14px;border-left:3px solid #d1d5db;background:#f9fafb;font:14px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#374151;white-space:pre-wrap">${escapeHtml(note)}</blockquote>` : ''}
<p style="margin:20px 0 0"><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#111827;color:#ffffff;text-decoration:none;font:600 14px -apple-system,Segoe UI,Helvetica,Arial,sans-serif">${escapeHtml(cta.label)}</a></p>
</div></body></html>`;
}

/**
 * A link to a local admin (localhost, *.localhost, *.test) is useless to the
 * person who receives it, and a local stack often holds copies of real
 * people's addresses, so local runs log the email instead of sending it.
 */
export function isLocalOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost') || h.endsWith('.test');
  } catch {
    return false;
  }
}

async function sendMail(to: string, subject: string, html: string, fromName: string, origin: string): Promise<boolean> {
  if (isLocalOrigin(origin)) {
    const link = /href="([^"]+)"/.exec(html)?.[1] ?? '';
    // eslint-disable-next-line no-console
    console.log(`[newsletters] approval email NOT sent (local admin ${origin}): to=${logSafe(to)} subject="${logSafe(subject)}" link=${logSafe(link.replace(/&amp;/g, '&'))}`);
    return true;
  }
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    // eslint-disable-next-line no-console
    console.warn('[newsletters] approval email not sent: SENDGRID_API_KEY or EMAIL_FROM is not set');
    return false;
  }
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from, name: fromName },
        subject,
        content: [{ type: 'text/html', value: html }],
        // Notifications about admin work, not marketing: no click rewriting.
        tracking_settings: { click_tracking: { enable: false }, open_tracking: { enable: false } },
      }),
    });
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[newsletters] approval email to ${to} failed: SendGrid ${r.status}`);
    }
    return r.ok;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[newsletters] approval email failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

// The 096 functions raise these codes with messages written for people;
// anything else is an unexpected database error whose text stays in the log.
const KNOWN_RPC_CODES: Record<string, number> = { '42501': 403, '55006': 409, P0002: 404, '22023': 400 };

function rpcError(res: Response, error: { code?: string; message?: string }): void {
  const status = error.code ? KNOWN_RPC_CODES[error.code] : undefined;
  if (status) {
    res.status(status).json({ error: { code: error.code, message: error.message ?? 'Request failed' } });
    return;
  }
  // eslint-disable-next-line no-console
  console.error('[newsletters] approval rpc failed:', error.code, error.message);
  res.status(500).json({ error: { code: 'rpc_error', message: 'The approval could not be recorded. Try again.' } });
}

/** One line, no control characters: for values written to the log. */
function logSafe(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 300);
}

function editionLabel(ed: EditionInfo): string {
  const date = ed.edition_date ? new Date(`${ed.edition_date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
  return `${ed.title || 'Untitled edition'}${date ? ` (${date})` : ''}`;
}

export function registerApprovalRoutes(router: Router, wrap: Wrap): void {
  router.post('/newsletters/editions/:editionId/approval/request', wrap(async (req, res) => {
    const editionId = req.params.editionId;
    if (!UUID.test(editionId)) { res.status(400).json({ error: { code: 'bad_id', message: 'Invalid edition id' } }); return; }
    const asUser = callerClient(req);
    if (!asUser) { res.status(401).json({ error: { code: 'unauthorized', message: 'Missing bearer token' } }); return; }
    const userId = (req as Request & { userId?: string }).userId ?? null;
    if (!rateLimit(`nl-approval:${userId ?? 'anon'}`, 10, 60_000)) {
      res.status(429).json({ error: { code: 'rate_limited', message: 'Too many approval requests; wait a minute.' } });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const note = cleanNote(body.note);
    const origin = resolveAdminOrigin(process.env.ADMIN_URL, req.headers.origin, body.admin_origin);
    // At most a few approval emails per edition per 10 minutes.
    if (!rateLimit(`nl-approval-edition:${editionId}`, 3, 10 * 60_000)) {
      res.status(429).json({ error: { code: 'rate_limited', message: 'Approval for this edition was requested a moment ago. Wait a few minutes before sending it again.' } });
      return;
    }

    const { data, error } = await asUser.rpc('newsletters_request_edition_approval', { p_edition_id: editionId, p_note: note });
    if (error) { rpcError(res, error); return; }
    const result = data as { approval_id: string; approvers: Array<{ email: string | null; name: string | null }> };

    const ed = await loadEdition(editionId);
    const newsletter = ed?.collection?.name || 'Newsletter';
    const requester = await callerName(userId);
    const link = `${origin ?? ''}/newsletters/approve/${editionId}`;
    const subject = `Approval needed: ${newsletter}${ed?.title ? ` - ${ed.title}` : ''}`;
    const html = emailHtml(
      `${newsletter} is ready for your approval`,
      [
        `${escapeHtml(requester)} has asked you to approve <strong>${escapeHtml(ed ? editionLabel(ed) : 'an edition')}</strong>.`,
        'You can edit the content before you approve it. It cannot be sent until it is approved.',
      ],
      note,
      { label: 'Review and approve', url: link },
    );
    const notified: string[] = [];
    const failed: string[] = [];
    // The request is recorded either way; email is best-effort. Without
    // ADMIN_URL there is no trustworthy link to send, so no email goes out
    // and the response says so (the approver can still open the approval
    // view from the edition's Sending tab).
    if (!origin) {
      // eslint-disable-next-line no-console
      console.warn('[newsletters] approval requested but not emailed: ADMIN_URL is not set on the api');
      res.json({ approval_id: result.approval_id, notified, failed: (result.approvers ?? []).map((a) => a.email).filter(Boolean), email_skipped: 'admin_url_not_configured' });
      return;
    }
    for (const a of result.approvers ?? []) {
      if (!a.email) continue;
      (await sendMail(a.email, subject, html, newsletter, origin)) ? notified.push(a.email) : failed.push(a.email);
    }
    res.json({ approval_id: result.approval_id, notified, failed, ...(isLocalOrigin(origin) ? { local_only: true } : {}) });
  }));

  router.post('/newsletters/editions/:editionId/approval/decide', wrap(async (req, res) => {
    const editionId = req.params.editionId;
    if (!UUID.test(editionId)) { res.status(400).json({ error: { code: 'bad_id', message: 'Invalid edition id' } }); return; }
    const asUser = callerClient(req);
    if (!asUser) { res.status(401).json({ error: { code: 'unauthorized', message: 'Missing bearer token' } }); return; }
    const userId = (req as Request & { userId?: string }).userId ?? null;
    if (!rateLimit(`nl-approval:${userId ?? 'anon'}`, 10, 60_000)) {
      res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests; wait a minute.' } });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decision = body.decision;
    if (decision !== 'approved' && decision !== 'changes_requested') {
      res.status(400).json({ error: { code: 'bad_decision', message: 'decision must be approved or changes_requested' } });
      return;
    }
    const expected = body.expected_version;
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
      res.status(400).json({ error: { code: 'bad_version', message: 'expected_version is required' } });
      return;
    }
    const note = cleanNote(body.note);
    if (decision === 'changes_requested' && !note) {
      res.status(400).json({ error: { code: 'note_required', message: 'Say what needs to change' } });
      return;
    }
    const { data, error } = await asUser.rpc('newsletters_decide_edition_approval', {
      p_edition_id: editionId, p_decision: decision, p_expected_version: expected, p_note: note,
    });
    if (error) { rpcError(res, error); return; }
    const result = data as { approval_id: string; status: string; notify: { email: string | null } | null };

    let notified: string | null = null;
    const to = result.notify?.email ?? null;
    const origin = resolveAdminOrigin(process.env.ADMIN_URL, req.headers.origin, body.admin_origin);
    if (to && origin) {
      const ed = await loadEdition(editionId);
      const newsletter = ed?.collection?.name || 'Newsletter';
      const approver = await callerName(userId);
      const slug = ed?.collection?.slug;
      const link = slug
        ? `${origin}/newsletters/${encodeURIComponent(slug)}/editions/${editionId}/sending`
        : `${origin}/newsletters/editor/${editionId}/sending`;
      const approved = decision === 'approved';
      const label = ed ? editionLabel(ed) : 'the edition';
      const html = emailHtml(
        approved ? `${newsletter} is approved` : `${newsletter}: changes requested`,
        approved
          ? [`${escapeHtml(approver)} approved <strong>${escapeHtml(label)}</strong>. You can send it now, or it will go at its scheduled time.`]
          : [`${escapeHtml(approver)} asked for changes to <strong>${escapeHtml(label)}</strong>. Make them, then request approval again.`],
        note,
        { label: approved ? 'Open the Sending tab' : 'Open the edition', url: link },
      );
      if (await sendMail(to, `${approved ? 'Approved' : 'Changes requested'}: ${newsletter}${ed?.title ? ` - ${ed.title}` : ''}`, html, newsletter, origin)) {
        notified = to;
      }
    }
    res.json({ approval_id: result.approval_id, status: result.status, notified });
  }));
}
