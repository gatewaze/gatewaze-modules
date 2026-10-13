// @ts-nocheck — express + supabase-js are resolved at module-host install time.

/**
 * Welcome-DM routes.
 *
 * Two routers, because the platform gates every /api/modules/<id>/* path to a
 * super_admin JWT EXCEPT paths containing /internal/ (packages/api routes/
 * modules.ts):
 *
 *   /api/modules/slack/internal/events          POST  Slack Events API
 *   /api/modules/slack/internal/oauth/callback  GET   Slack's OAuth redirect
 *     Neither can carry our JWT. Each authenticates itself: the events route
 *     by Slack's request signature, the callback by a signed `state` that only
 *     the gated connect-link route issues.
 *
 *   /api/modules/slack/welcome/*                 super_admin (platform gate)
 *     status, connect-link, disconnect, test, log, retry.
 *
 * No route ever returns the sender's token.
 */

import { createHash } from 'crypto';
import { Router, type Express, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';

import { serviceClient } from '../lib/service-client.js';
import { sealSecret } from '../lib/secret-envelope.js';
import {
  authorizeUrl, checkState, delayMs, isWelcomable, renderWelcomeMessage, requireSignedIn, signState, slackErrorCode,
  verifySlackSignature, DEFAULT_DELAY_MINUTES, DEFAULT_MESSAGE, MAX_EMAIL_CHARS, MAX_MESSAGE_CHARS, STATE_TTL_MS,
  USER_SCOPES, WELCOME_PURPOSE,
} from '../lib/welcome.js';
import {
  LOG_TABLE, TOKENS_TABLE, invalidateConfig, readSender, readSenderWithToken, readSlackConfig,
  sendDirectMessage, slackApi,
} from '../lib/welcome-store.js';

const JOB_NAME = 'slack:welcome-dm';
const JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: 500,
  removeOnFail: 500,
};
const EMAIL_RE = /^[^@\s,<>]+@[^@\s,<>]+\.[^@\s,<>]+$/;

/** A trimmed, lower-cased email from a request body, or '' if it is not one. */
function bodyEmail(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_EMAIL_CHARS) return '';
  const email = value.trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : '';
}
const LOG_COLUMNS = 'id, team_id, slack_user_id, email, first_name, display_name, person_id, joined_at, send_after, status, skip_reason, error, attempts, sent_as, sent_at';

/** HTML-escape. Every value that reaches the callback page goes through this. */
function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * The OAuth return page, seen by a person in a browser. Takes plain-text
 * paragraphs, never HTML, so nothing reflected from the query string can be
 * interpolated unescaped (the reflected-XSS lesson from videos-publisher-youtube).
 */
function page(title: string, paragraphs: string[]): string {
  const body = paragraphs.map((p) => `<p>${esc(p)}</p>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
    `<title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem}</style>` +
    `</head><body><h1>${esc(title)}</h1>${body}<p>You can close this tab.</p></body></html>`;
}

export function registerRoutes(app: Express, ctx?: Record<string, any>): void {
  const supabase = serviceClient();
  const log = (m: string, meta?: Record<string, unknown>) => console.log(`[slack:welcome] ${m}`, meta ?? '');

  const apiBase = (process.env.API_URL ?? process.env.API_EXTERNAL_URL ?? '').replace(/\/+$/, '');
  const redirectUri = `${apiBase}/api/modules/slack/internal/oauth/callback`;
  const eventsUrl = `${apiBase}/api/modules/slack/internal/events`;

  async function enqueue(logId: string, delay: number, jobId?: string) {
    if (!ctx || typeof ctx.enqueueJob !== 'function') {
      log('enqueueJob unavailable — the welcome stays pending until Retry is pressed', { logId });
      return null;
    }
    try {
      const r = await ctx.enqueueJob('jobs', JOB_NAME, { logId }, { ...JOB_OPTS, delay, ...(jobId ? { jobId } : {}) });
      return r && r.id ? r.id : null;
    } catch (err) {
      log('enqueue failed — the welcome stays pending until Retry is pressed', { logId, error: String(err) });
      return null;
    }
  }

  /** Look a person up in Slack by email, with the bot token. */
  async function lookupSlackUser(botToken: string, email: string) {
    const r = await slackApi('users.lookupByEmail', botToken, { email });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, user: r.user };
  }

  // ── Public: Slack calls these ─────────────────────────────────────────────

  const pub = Router();
  // Joins come one at a time; a burst far above this is not Slack.
  pub.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

  pub.post('/events', async (req: Request, res: Response) => {
    let cfg;
    try {
      cfg = await readSlackConfig(supabase);
    } catch (err) {
      log('config unavailable', { error: String(err) });
      return res.status(503).json({ error: 'unavailable' });
    }
    const check = verifySlackSignature({
      signingSecret: cfg.signingSecret,
      timestamp: req.get('x-slack-request-timestamp'),
      signature: req.get('x-slack-signature'),
      rawBody: req.rawBody,
    });
    if (!check.ok) {
      log('rejected an events request', { reason: check.reason });
      return res.status(401).json({ error: 'invalid signature' });
    }

    const body = req.body || {};
    // Slack's one-time check when the Request URL is saved in the app config.
    if (body.type === 'url_verification') {
      return res.json({ challenge: String(body.challenge ?? '') });
    }
    if (body.type !== 'event_callback' || !body.event || body.event.type !== 'team_join') {
      return res.status(200).json({ ok: true });
    }

    try {
      await recordJoin(String(body.team_id || ''), body.event.user, cfg);
      return res.status(200).json({ ok: true });
    } catch (err) {
      // A 5xx makes Slack redeliver; the unique (team, user) key makes that safe.
      log('could not record a join', { error: String(err) });
      return res.status(500).json({ error: 'not recorded' });
    }
  });

  async function recordJoin(teamId: string, user: any, cfg: any) {
    if (!teamId || !user || !user.id) return;
    const sender = await readSender(supabase);
    if (sender && sender.team_id !== teamId) {
      log('ignored a join from a workspace this install does not welcome for', { teamId });
      return;
    }

    const profile = user.profile || {};
    const email = bodyEmail(profile.email) || null;
    let personId = null;
    if (email) {
      const { data: people } = await supabase.from('people').select('id').eq('email', email).limit(1);
      personId = people && people[0] ? people[0].id : null;
    }

    const who = isWelcomable(user, sender ? sender.slack_user_id : null);
    let status = 'pending';
    let skipReason = null;
    if (!who.ok) { status = 'skipped'; skipReason = who.reason; }
    else if (!cfg.enabled) { status = 'skipped'; skipReason = 'welcome DMs are turned off'; }
    else if (!sender) { status = 'skipped'; skipReason = 'no sender connected'; }
    else if (sender.status !== 'connected') { status = 'skipped'; skipReason = 'the sender connection needs reconnecting'; }

    const delay = delayMs(cfg.delayMinutes);
    const row = {
      team_id: teamId,
      slack_user_id: user.id,
      email,
      first_name: (profile.first_name || '').slice(0, 200) || null,
      display_name: (profile.real_name || user.real_name || profile.display_name || '').slice(0, 200) || null,
      person_id: personId,
      status,
      skip_reason: skipReason,
      send_after: status === 'pending' ? new Date(Date.now() + delay).toISOString() : null,
    };
    const { data, error } = await supabase
      .from(LOG_TABLE)
      .upsert(row, { onConflict: 'team_id,slack_user_id', ignoreDuplicates: true })
      .select('id, status');
    if (error) throw new Error(error.message);
    const inserted = data && data[0];
    if (!inserted) return; // a redelivery of a join we already have
    log('join recorded', { status, skipReason });
    if (inserted.status === 'pending') await enqueue(inserted.id, delay, `slack-welcome-${inserted.id}`);
  }

  pub.get('/oauth/callback', async (req: Request, res: Response) => {
    // A page a person sees, reached from slack.com: nothing on it needs a
    // script, a frame or a referrer.
    res.set({
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
    });
    const send = (code: number, title: string, ...paragraphs: string[]) =>
      res.status(code).type('html').send(page(title, paragraphs));

    if (req.query.error !== undefined) {
      return send(400, 'Not connected', `Slack reported: ${slackErrorCode(req.query.error)}`);
    }
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!state || !code) return send(400, 'Not connected', 'The link was missing its code or state.');

    // Once Slack has issued a token, it is either stored or revoked: every
    // exit below that does not store it, including a thrown error, revokes it.
    let userToken: string | null = null;
    let stored = false;
    try {
      let cfg;
      try {
        cfg = await readSlackConfig(supabase);
      } catch {
        return send(503, 'Not connected', 'The server could not read the Slack settings. Try again shortly.');
      }
      if (!cfg.clientId || !cfg.clientSecret) {
        return send(503, 'Not connected', 'The Slack app credentials are not configured in Gatewaze.');
      }
      const checked = checkState(state, cfg.clientSecret);
      if (!checked.ok) {
        log('refused an OAuth return', { reason: checked.reason });
        return send(403, 'Not connected', checked.reason === 'expired'
          ? 'This link has expired. Ask for a new one from the Gatewaze Slack welcome page.'
          : 'This link was not issued by this server. Ask for a new one from the Gatewaze Slack welcome page.');
      }

      const exchange = await slackApi('oauth.v2.access', null, {
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: redirectUri,
      });
      const authed = exchange && exchange.authed_user;
      if (authed && authed.access_token) userToken = String(authed.access_token);
      if (!exchange.ok || !userToken) {
        log('code exchange failed', { error: exchange.error });
        return send(400, 'Not connected', `Slack did not accept the authorisation (${slackErrorCode(exchange.error || 'no_user_token')}).`);
      }

      // The link names the account and workspace it is for. Anyone else
      // completing it would make the welcome DMs come from their account.
      const teamId = (exchange.team && exchange.team.id) || '';
      if (authed.id !== checked.state.x || (checked.state.t && teamId !== checked.state.t)) {
        log('refused: the link was completed by a different Slack account or workspace');
        return send(403, 'Not connected',
          'This link was created for a different Slack account. Sign in to Slack as the person it was created for, then open the link again.');
      }
      const granted = String(authed.scope || '').split(',').map((s) => s.trim());
      const missing = USER_SCOPES.filter((s) => !granted.includes(s));
      if (missing.length) {
        return send(400, 'Not connected', `Slack did not grant the permissions needed: ${missing.join(', ')}.`);
      }

      const sealed = sealSecret(userToken);
      if (!sealed) {
        log('GATEWAZE_SECRETS_KEY unavailable — refusing to store the token');
        return send(503, 'Not connected', 'The server cannot encrypt credentials at the moment, so nothing was stored.');
      }

      let name = authed.id;
      if (cfg.botToken) {
        const info = await slackApi('users.info', cfg.botToken, { user: authed.id });
        if (info.ok && info.user) name = info.user.real_name || info.user.name || name;
      }

      // Read the account being replaced before overwriting it, and revoke its
      // token only once the new one is safely stored.
      const previous = await readSenderWithToken(supabase);
      const { error } = await supabase.from(TOKENS_TABLE).upsert({
        purpose: WELCOME_PURPOSE,
        team_id: teamId,
        slack_user_id: authed.id,
        slack_user_name: String(name).slice(0, 200),
        scopes: granted.join(','),
        token_sealed: sealed,
        connected_by: checked.state.u,
        connected_at: new Date().toISOString(),
        status: 'connected',
        status_detail: null,
      }, { onConflict: 'purpose' });
      if (error) {
        log('could not store the connection', { error: error.message });
        return send(500, 'Not connected', 'Authorised, but the connection could not be saved.');
      }
      stored = true;
      if (previous && previous.token && previous.token !== userToken) {
        await slackApi('auth.revoke', previous.token).catch(() => undefined);
      }
      log('sender connected', { slackUserId: authed.id, teamId, by: checked.state.u });
      return send(200, 'Connected', `Welcome DMs will be sent from ${name}'s Slack account.`);
    } catch (err) {
      log('OAuth return failed', { error: String(err) });
      if (!res.headersSent) return send(500, 'Not connected', 'Something went wrong, so nothing was stored. Try the link again.');
    } finally {
      if (userToken && !stored) await slackApi('auth.revoke', userToken).catch(() => undefined);
    }
  });

  app.use('/api/modules/slack/internal', pub);

  // ── Admin: super_admin via the platform gate ──────────────────────────────

  const adm = Router();
  adm.use(requireSignedIn);
  adm.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
  // Each test is a real DM from a real person's account.
  const testLimit = rateLimit({ windowMs: 10 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });

  adm.get('/status', async (_req: Request, res: Response) => {
    try {
      invalidateConfig();
      const cfg = await readSlackConfig(supabase);
      const sender = await readSender(supabase);
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const { data: rows } = await supabase.from(LOG_TABLE).select('status').gte('joined_at', since);
      const counts: Record<string, number> = {};
      for (const r of rows || []) counts[r.status] = (counts[r.status] || 0) + 1;
      res.json({
        setup: {
          client_id: !!cfg.clientId,
          client_secret: !!cfg.clientSecret,
          signing_secret: !!cfg.signingSecret,
          bot_token: !!cfg.botToken,
          secrets_key: !!sealSecret('probe'),
          api_url: !!apiBase,
        },
        urls: { events: eventsUrl, redirect: redirectUri },
        user_scopes: USER_SCOPES,
        sender,
        settings: {
          enabled: cfg.enabled,
          message: cfg.message || DEFAULT_MESSAGE,
          delay_minutes: cfg.delayMinutes,
        },
        defaults: { message: DEFAULT_MESSAGE, delay_minutes: DEFAULT_DELAY_MINUTES },
        last_30_days: counts,
      });
    } catch (err) {
      log('status failed', { error: String(err) });
      res.status(500).json({ error: 'Could not read the welcome DM status.' });
    }
  });

  /** A link for the sender to open in their own browser. Bound to their Slack account. */
  adm.post('/connect-link', async (req: Request, res: Response) => {
    const email = bodyEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Enter the Slack email address of the person the DMs should come from.' });
    if (!apiBase) return res.status(503).json({ error: 'API_URL is not set, so the redirect URI cannot be built.' });
    const cfg = await readSlackConfig(supabase);
    if (!cfg.clientId || !cfg.clientSecret) return res.status(503).json({ error: 'Set the Slack app client ID and secret first.' });
    if (!cfg.botToken) return res.status(503).json({ error: 'Set the Slack bot token first; it is used to find the account by email.' });
    const found = await lookupSlackUser(cfg.botToken, email);
    if (!found.ok) {
      return res.status(404).json({ error: found.error === 'users_not_found'
        ? 'No member of the workspace has that email address.'
        : `Slack lookup failed (${found.error}).` });
    }
    const auth = await slackApi('auth.test', cfg.botToken);
    const teamId = auth.ok && auth.team_id ? String(auth.team_id) : undefined;
    const state = signState({ u: req.userId, x: found.user.id, t: teamId }, cfg.clientSecret);
    log('connect link issued', { by: req.userId, for: found.user.id });
    res.json({
      authorize_url: authorizeUrl({ clientId: cfg.clientId, redirectUri, state, teamId }),
      for: { id: found.user.id, name: found.user.real_name || found.user.name },
      expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
    });
  });

  adm.post('/disconnect', async (req: Request, res: Response) => {
    const sender = await readSenderWithToken(supabase);
    if (sender && sender.token) await slackApi('auth.revoke', sender.token);
    const { error } = await supabase.from(TOKENS_TABLE).delete().eq('purpose', WELCOME_PURPOSE);
    if (error) return res.status(500).json({ error: error.message });
    log('sender disconnected', { by: req.userId });
    res.json({ ok: true });
  });

  /** Send the welcome, as it stands now, to one member. Writes nothing to the log. */
  adm.post('/test', testLimit, async (req: Request, res: Response) => {
    const email = bodyEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Enter the Slack email address to send the test to.' });
    const draft = typeof req.body?.message === 'string' ? req.body.message : null;
    if (draft !== null && draft.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: `Keep the message under ${MAX_MESSAGE_CHARS} characters.` });
    }
    const cfg = await readSlackConfig(supabase);
    if (!cfg.botToken) return res.status(503).json({ error: 'Set the Slack bot token first.' });
    const sender = await readSenderWithToken(supabase);
    if (!sender) return res.status(409).json({ error: 'Connect the sender first.' });
    if (!sender.token) return res.status(503).json({ error: 'The stored token could not be decrypted (GATEWAZE_SECRETS_KEY changed?). Reconnect the sender.' });
    const found = await lookupSlackUser(cfg.botToken, email);
    if (!found.ok) return res.status(404).json({ error: `Slack lookup failed (${found.error}).` });
    const text = renderWelcomeMessage(draft ?? cfg.message, found.user);
    const sent = await sendDirectMessage(sender.token, found.user.id, text);
    // Who sent what to whom, without the text itself.
    const audit = {
      by: req.userId,
      to: found.user.id,
      as: sender.slack_user_id,
      text_sha256: createHash('sha256').update(text).digest('hex').slice(0, 16),
      ok: sent.ok,
    };
    if (!sent.ok) {
      log('test welcome refused by Slack', { ...audit, error: sent.error });
      return res.status(502).json({ error: `Slack refused the message (${slackErrorCode(sent.error)}).` });
    }
    log('test welcome sent', audit);
    res.json({ ok: true, to: found.user.real_name || found.user.name, from: sender.slack_user_name });
  });

  adm.get('/log', async (_req: Request, res: Response) => {
    const { data, error } = await supabase.from(LOG_TABLE).select(LOG_COLUMNS).order('joined_at', { ascending: false }).limit(100);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ rows: data || [] });
  });

  /**
   * Re-queue welcomes that are stuck (pending, or a crashed 'sending') and,
   * on request, ones that failed. A send is claimed atomically from
   * 'pending', so re-queuing a row that is already queued cannot send twice.
   */
  adm.post('/retry', async (req: Request, res: Response) => {
    const includeFailed = req.body?.include_failed === true;
    log('retry requested', { by: req.userId, includeFailed });
    const stuckBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await supabase.from(LOG_TABLE).update({ status: 'pending' }).eq('status', 'sending').lt('updated_at', stuckBefore);
    if (includeFailed) await supabase.from(LOG_TABLE).update({ status: 'pending', error: null }).eq('status', 'failed');
    const { data, error } = await supabase.from(LOG_TABLE).select('id').eq('status', 'pending').limit(500);
    if (error) return res.status(500).json({ error: error.message });
    let queued = 0;
    for (const r of data || []) {
      if (await enqueue(r.id, 0, `slack-welcome-${r.id}-r${Date.now()}`)) queued++;
    }
    res.json({ ok: true, queued });
  });

  app.use('/api/modules/slack/welcome', adm);
  log('routes registered', { events: eventsUrl });
}
