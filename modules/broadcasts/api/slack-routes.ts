/**
 * Slack broadcast admin routes, mounted at /api/admin/modules/broadcasts/slack.
 *
 *   GET  /status  Is each sender usable? Checks the bot token with auth.test
 *                 and reports its scopes; reports the welcome-DM account.
 *   POST /test    Send the message to one person, by email, as a test DM.
 *
 * Module routes are not gated by the platform, so the router verifies the
 * session itself (lib/require-jwt.ts) and then checks admin_profiles. No
 * route ever returns a token.
 */
import express, { type Request, type Response, type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { requireJwt } from '../lib/require-jwt.js';
import { readSlackToken, scanTokens, slackSubstitutions, type SlackSender } from '../lib/slack-message.js';
import { makeSlackChannelProvider, MAX_SLACK_MESSAGE_CHARS } from '../../bulk-emailing/worker/send-engine/channels/slack.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = any;

export const REQUIRED_BOT_SCOPES = ['chat:write', 'im:write'];
// Domain labels exclude '.', so each dot has one way to match (no ReDoS).
const EMAIL_RE = /^[^@\s,<>]+@[^@\s,<>.]+(?:\.[^@\s,<>.]+)+$/;
const ADMIN_ROLES = ['super_admin', 'admin', 'editor'];
// A test as the welcome-DM account is a message from a real person's own
// Slack account, so editors can only test as the bot.
const PERSON_SENDER_ROLES = ['super_admin', 'admin'];

type FetchLike = (url: string, init: RequestInit) => Promise<globalThis.Response>;

export interface SlackRouteDeps {
  supabase: SB;
  fetchImpl?: FetchLike;
  readToken?: (sb: SB, sender: SlackSender) => Promise<string>;
  readSender?: (sb: SB) => Promise<{ slack_user_name?: string | null; status?: string | null } | null>;
}

export function parseSender(v: unknown): SlackSender | null {
  return v === 'bot' || v === 'welcome_sender' ? v : null;
}

/** Escape LIKE wildcards so an address matches only itself. PostgREST also
 *  reads `*` as a wildcard, so addresses containing one are refused upstream. */
function likeExact(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** POST /test. Exported for tests; the router adds auth and rate limiting. */
export function createSlackTestHandler(deps: SlackRouteDeps) {
  const readToken = deps.readToken ?? readSlackToken;
  const provider = makeSlackChannelProvider(deps.fetchImpl as never);
  return async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const text = typeof body.text === 'string' ? body.text : '';
    const sender = parseSender(body.sender ?? 'bot');
    if (email.length > 254 || !EMAIL_RE.test(email) || email.includes('*')) { res.status(400).json({ error: 'Enter a valid email address' }); return; }
    if (!sender) { res.status(400).json({ error: 'Unknown sender' }); return; }
    const role = (req as Request & { adminRole?: string }).adminRole;
    if (sender === 'welcome_sender' && !(role && PERSON_SENDER_ROLES.includes(role))) {
      res.status(403).json({ error: 'Only admins can send a test as the welcome-DM account' });
      return;
    }
    if (!text.trim()) { res.status(400).json({ error: 'The message is empty' }); return; }
    if (text.length > MAX_SLACK_MESSAGE_CHARS) { res.status(400).json({ error: `The message is over ${MAX_SLACK_MESSAGE_CHARS} characters` }); return; }

    const { data: people, error } = await deps.supabase
      .from('people').select('id, email, attributes').ilike('email', likeExact(email)).limit(2);
    if (error) { res.status(500).json({ error: 'Could not look up that person' }); return; }
    const person = (people ?? []).find((p: { attributes?: Record<string, unknown> }) => typeof p.attributes?.slack_user_id === 'string' && p.attributes.slack_user_id);
    if (!person) {
      res.status(404).json({ error: (people ?? []).length ? 'That person is not linked to a Slack member' : 'No person has that email address' });
      return;
    }

    let token: string;
    try {
      token = await readToken(deps.supabase, sender);
    } catch {
      res.status(503).json({ error: 'Could not read the Slack settings' });
      return;
    }
    const attrs = (person.attributes ?? {}) as Record<string, unknown>;
    const result = await provider.sendBatch({
      from: '', subject: '', bodyText: text, auth: { token },
      personalizations: [{ to: String(attrs.slack_user_id).trim(), substitutions: slackSubstitutions(scanTokens(text), attrs, person.email) }],
    });
    if (result.success) { res.json({ success: true }); return; }
    res.status(502).json({ error: result.haltSend ?? result.error ?? 'Slack refused the message' });
  };
}

/** GET /status. */
export function createSlackStatusHandler(deps: SlackRouteDeps) {
  const readToken = deps.readToken ?? readSlackToken;
  const fetchImpl = deps.fetchImpl ?? fetch;
  return async (_req: Request, res: Response): Promise<void> => {
    const out: Record<string, unknown> = {};
    try {
      const token = await readToken(deps.supabase, 'bot');
      if (!token) {
        out.bot = { configured: false };
      } else {
        const r = await fetchImpl('https://slack.com/api/auth.test', {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
        });
        const json = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; team?: string; user?: string };
        const scopes = (r.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        out.bot = {
          configured: true, ok: !!json.ok, error: json.ok ? undefined : json.error, team: json.team, name: json.user,
          missing_scopes: json.ok ? REQUIRED_BOT_SCOPES.filter((s) => !scopes.includes(s)) : undefined,
        };
      }
    } catch {
      out.bot = { configured: true, ok: false, error: 'could not reach Slack' };
    }
    try {
      const s = deps.readSender ? await deps.readSender(deps.supabase) : null;
      out.welcome_sender = s ? { connected: true, name: s.slack_user_name ?? null, status: s.status ?? null } : { connected: false };
    } catch {
      out.welcome_sender = { connected: false };
    }
    res.json(out);
  };
}

export function createSlackRouter(deps: SlackRouteDeps): Router {
  const router = express.Router();
  // Limit before anything else, including the token check.
  router.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
  router.use(express.json({ limit: '32kb' }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  router.use(requireJwt() as any);
  router.use(async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId;
      if (!userId) { res.status(401).json({ error: 'Not signed in' }); return; }
      const { data, error } = await deps.supabase.from('admin_profiles').select('role, is_active').eq('user_id', userId).maybeSingle();
      if (error || !data || !data.is_active || !ADMIN_ROLES.includes(data.role)) {
        res.status(403).json({ error: 'Admin access required' });
        return;
      }
      (req as Request & { adminRole?: string }).adminRole = data.role;
      next();
    } catch {
      res.status(403).json({ error: 'Admin access required' });
    }
  });
  // Each test is a real DM to a real person.
  // Keyed on the signed-in admin (set by requireJwt), not the address.
  const testLimit = rateLimit({
    windowMs: 10 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `user:${(req as Request & { userId?: string }).userId ?? 'unknown'}`,
  });
  // Express 4 does not catch a rejected async handler; answer 500 instead of
  // leaving the request hanging.
  const safe = (h: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
    h(req, res).catch(() => { if (!res.headersSent) res.status(500).json({ error: 'Internal error' }); });
  };
  router.get('/status', safe(createSlackStatusHandler(deps)));
  router.post('/test', testLimit, safe(createSlackTestHandler(deps)));
  return router;
}
