// @ts-nocheck — supabase-js + express are resolved at module-host install time.

/**
 * The OAuth client settings and the connect flow.
 *
 * Settings, start and the connections list are mounted under
 * /api/modules/videos-publisher-youtube, which the platform gates to
 * super_admin for everything except /internal/*. That gate is wanted here:
 * these routes store the OAuth client and hand out a URL that grants upload
 * rights to a channel.
 *
 * The begin and callback steps cannot be behind a bearer token, because they
 * are browser navigations (to us, and back from Google), so they are mounted
 * outside /api/modules under CALLBACK_PATH's prefix. (The callback used to
 * sit under /api/modules, where the platform gate answered Google's redirect
 * with a 401 and no channel could ever connect.) They are protected by
 * single-use secrets instead: /oauth/start (super_admin) mints a ticket,
 * /oauth/begin spends it and mints the state plus a browser-binding cookie,
 * and the callback needs both. See the comment on TICKETS and PENDING below.
 */

import { Router, type Express, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, timingSafeEqual } from 'crypto';

import { authorizeUrl, CALLBACK_PATH, exchangeCode, fetchChannel, redirectUri, revokeToken, SCOPES } from '../lib/oauth.js';
import { parseSettingsPatch, readClientSecret } from '../lib/settings.js';
import { loadClientCredentials, readModuleConfig } from '../lib/client-credentials.js';
import { serviceClient } from '../lib/service-client.js';
import { sealSecret, unsealSecret } from '../lib/secret-envelope.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a disconnect records, and how the list tells the two apart. */
export const DETAIL_REVOKED = 'Disconnected by an admin; access revoked at Google.';
export const DETAIL_REVOKE_UNCONFIRMED =
  'Disconnected by an admin, but Google did not confirm the access was revoked. '
  + 'Remove this app under the channel account\'s third-party access (myaccount.google.com/permissions).';

/**
 * The connect flow has two single-use secrets, both in memory and short-lived.
 *
 *   ticket   minted by /oauth/start (super_admin). The admin's own tab opens
 *            /oauth/begin?ticket=…, which spends it.
 *   state    minted by /oauth/begin together with a browser binding, which is
 *            set as an HttpOnly cookie on that tab before it is sent to Google.
 *
 * The callback needs the state AND the matching cookie. So a Google consent
 * URL that leaks (pasted into chat, say) cannot be finished in someone else's
 * browser to attach their channel: they would not have the cookie. And the
 * ticket is spent the moment the admin's tab uses it.
 */
const TICKETS = new Map<string, { createdAt: number }>();
const PENDING = new Map<string, { createdAt: number; binding: string }>();
const STATE_TTL_MS = 10 * 60 * 1000;
const BIND_COOKIE = 'gw_yt_oauth_bind';

function sweepPending(): void {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, v] of PENDING) if (v.createdAt < cutoff) PENDING.delete(k);
  for (const [k, v] of TICKETS) if (v.createdAt < cutoff) TICKETS.delete(k);
}

/** One cookie's value from a Cookie header, or ''. */
function cookieValue(header: string | undefined, name: string): string {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

/** Constant-time compare so a nonce cannot be guessed a character at a time. */
function nonceMatches(given: string, known: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(known);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** HTML-escape. Every value that reaches the page goes through this. */
function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * The callback's response page, seen by a human in a browser.
 *
 * Takes PARAGRAPHS rather than an HTML string on purpose. The first version
 * of this took a `body: string` and interpolated `req.query.error` and the
 * channel title into it unescaped — a reflected XSS on a route that, by
 * design, anyone can reach with any query string. Making the only way in a
 * list of plain-text paragraphs means a caller cannot forget to escape.
 */
function page(title: string, paragraphs: string[]): string {
  const body = paragraphs.map((p) => `<p>${esc(p)}</p>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
    `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem}` +
    `</style></head>` +
    `<body><h1>${esc(title)}</h1>${body}<p>You can close this tab and return to Gatewaze.</p></body></html>`;
}

/** The adapter's ceiling for one discovery run, and the de-duplication window for Sync now. */
export const SYNC_CAP = 5000;
const SYNC_WINDOW_MS = 10 * 60 * 1000;

type EnqueueJob = (
  queue: string,
  name: string,
  data: Record<string, unknown>,
  opts?: Record<string, unknown>,
) => Promise<{ id: string | undefined }>;

export function registerRoutes(app: Express, ctx?: Record<string, unknown>): void {
  const enqueueJob = ctx?.enqueueJob as EnqueueJob | undefined;
  const supabase = serviceClient();

  const log = (m: string, meta?: Record<string, unknown>) =>
    console.log(`[videos-publisher-youtube] ${m}`, meta ?? '');

  /** The public API base Google must redirect back to. */
  const apiBase = (process.env.API_URL ?? process.env.API_EXTERNAL_URL ?? '').replace(/\/+$/, '');

  /**
   * The OAuth client, read from this module's own sealed config.
   *
   * Sealed with the platform envelope, so this is decrypted here and never
   * leaves the server. Null means unconfigured, which callers turn into "set
   * the credentials first". A failed read is NOT unconfigured: it throws, and
   * callers answer it as the read failure it is (lib/client-credentials.ts).
   */
  const moduleConfig = () => readModuleConfig(supabase);
  const clientCredentials = () => loadClientCredentials(supabase);

  const router = Router();
  const callbackRouter = Router();

  // Limiter first, before any handler, on both routers. /oauth/start mints a
  // ticket, and /oauth/begin and /oauth/callback are reachable by anyone who
  // has the URL, so all need a ceiling that does not depend on the caller
  // being who they say they are. A real operator connects a channel perhaps
  // twice in a session.
  const limiter = () => rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'rate_limited', message: 'too many requests' },
  });
  router.use(limiter());
  callbackRouter.use(limiter());

  /**
   * The OAuth client as the settings page shows it. The secret is never
   * returned, sealed or not: only whether one is stored and usable.
   */
  router.get('/settings', async (_req: Request, res: Response) => {
    let cfg: Record<string, unknown>;
    try {
      cfg = await moduleConfig();
    } catch (err) {
      log('could not read settings', { error: (err as Error).message });
      return res.status(500).json({ error: 'The settings could not be read.' });
    }
    const stored = typeof cfg.clientSecret === 'string' && cfg.clientSecret !== '';
    res.json({
      clientId: typeof cfg.clientId === 'string' ? cfg.clientId : '',
      clientSecretSet: stored,
      // Stored but unreadable: the secrets key changed since it was saved.
      clientSecretReadable: stored ? readClientSecret(cfg.clientSecret) !== null : false,
      redirectUri: apiBase ? redirectUri(apiBase) : null,
      scopes: SCOPES,
    });
  });

  /**
   * Save the OAuth client. Only clientId and clientSecret are accepted, and
   * the secret is sealed before it is written. If it cannot be sealed, nothing
   * is written: a secret is never stored in the clear.
   */
  router.put('/settings', async (req: Request, res: Response) => {
    const parsed = parseSettingsPatch(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    const update: Record<string, unknown> = {};
    if (parsed.patch.clientId) update.clientId = parsed.patch.clientId;
    if (parsed.patch.clientSecret) {
      const sealed = sealSecret(parsed.patch.clientSecret);
      if (!sealed) {
        log('GATEWAZE_SECRETS_KEY is unavailable — refusing to store the client secret');
        return res.status(503).json({ error: 'The server cannot seal credentials at the moment, so nothing was saved.' });
      }
      update.clientSecret = sealed;
    }

    const { data: row, error: readErr } = await supabase
      .from('installed_modules')
      .select('config')
      .eq('id', 'videos-publisher-youtube')
      .maybeSingle();
    if (readErr) return res.status(500).json({ error: 'The module settings could not be read.' });
    if (!row) return res.status(404).json({ error: 'The module is not installed.' });
    const current = (row.config ?? {}) as Record<string, unknown>;
    // A secret belongs to one client. Changing the client without its secret
    // would leave a pair Google rejects at the first connect.
    if (update.clientId && update.clientId !== current.clientId && !update.clientSecret) {
      return res.status(400).json({ error: 'A new client ID needs its client secret too.' });
    }

    const { error } = await supabase
      .from('installed_modules')
      .update({ config: { ...current, ...update } })
      .eq('id', 'videos-publisher-youtube');
    if (error) {
      log('could not save the OAuth client', { error: error.message });
      return res.status(500).json({ error: 'The settings could not be saved.' });
    }
    log('OAuth client saved', { clientId: update.clientId ?? '(unchanged)', secretChanged: Boolean(update.clientSecret) });
    res.json({ ok: true });
  });

  /** Where to send the operator's browser to authorise a channel. */
  router.get('/oauth/start', async (_req: Request, res: Response) => {
    let client;
    try {
      client = await clientCredentials();
    } catch (err) {
      log('could not read settings', { error: (err as Error).message });
      return res.status(500).json({ error: 'The settings could not be read. Try again in a moment.' });
    }
    if (!client) {
      return res.status(503).json({
        error: 'The YouTube OAuth client is not configured. Add the client ID and secret under Videos → YouTube channels first.',
      });
    }
    if (!apiBase) {
      return res.status(503).json({ error: 'API_URL is not set, so the redirect URI cannot be built.' });
    }

    sweepPending();
    const ticket = randomBytes(32).toString('base64url');
    TICKETS.set(ticket, { createdAt: Date.now() });

    res.json({
      // Not Google's URL yet: /oauth/begin binds the admin's browser first.
      authorize_url: `${apiBase}${CALLBACK_PATH.replace(/\/oauth\/callback$/, '')}/oauth/begin?ticket=${ticket}`,
      // So the operator can check it against the console before clicking.
      redirect_uri: redirectUri(apiBase),
      scopes: SCOPES,
      expires_in_seconds: STATE_TTL_MS / 1000,
    });
  });

  /**
   * Opened by the admin's own tab with a ticket from /oauth/start. Spends the
   * ticket, binds this browser with a cookie, and sends it on to Google.
   */
  callbackRouter.get('/oauth/begin', async (req: Request, res: Response) => {
    const send = (code: number, title: string, ...paragraphs: string[]) =>
      res.status(code).type('html').send(page(title, paragraphs));
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    sweepPending();
    const known = ticket ? [...TICKETS.keys()].find((k) => nonceMatches(ticket, k)) : undefined;
    if (!known) {
      return send(403, 'Not connected', 'That link has expired or was already used. Start again from Gatewaze.');
    }
    TICKETS.delete(known);

    let client;
    try {
      client = await clientCredentials();
    } catch (err) {
      log('could not read settings', { error: (err as Error).message });
      return send(500, 'Not connected', 'The settings could not be read. Start again from Gatewaze in a moment.');
    }
    if (!client || !apiBase) return send(503, 'Not connected', 'The OAuth client is not configured.');

    const state = randomBytes(32).toString('base64url');
    const binding = randomBytes(32).toString('base64url');
    PENDING.set(state, { createdAt: Date.now(), binding });
    // SameSite=Lax still travels on Google's top-level redirect back to the
    // callback. Path-scoped to this flow; HttpOnly so no script can read it.
    res.cookie(BIND_COOKIE, binding, {
      httpOnly: true,
      secure: apiBase.startsWith('https://'),
      sameSite: 'lax',
      path: CALLBACK_PATH.replace(/\/oauth\/callback$/, ''),
      maxAge: STATE_TTL_MS,
    });
    res.redirect(302, authorizeUrl(client, apiBase, state));
  });

  /**
   * Google's redirect lands here, in a browser, with no bearer token.
   *
   * Authorised by the single-use `state` nonce together with the binding
   * cookie /oauth/begin set on the same browser.
   */
  callbackRouter.get('/oauth/callback', async (req: Request, res: Response) => {
    const send = (code: number, title: string, ...paragraphs: string[]) =>
      res.status(code).type('html').send(page(title, paragraphs));
    res.clearCookie(BIND_COOKIE, { path: CALLBACK_PATH.replace(/\/oauth\/callback$/, '') });

    const googleError = typeof req.query.error === 'string' ? req.query.error : null;
    if (googleError) {
      return send(400, 'Not connected', `Google reported: ${googleError}`);
    }

    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!state || !code) return send(400, 'Not connected', 'The callback was missing its code or state.');

    sweepPending();
    const known = [...PENDING.keys()].find((k) => nonceMatches(state, k));
    if (!known) {
      return send(403, 'Not connected', 'That authorisation link has expired or was not issued by this server. Start again from Gatewaze.');
    }
    // Single use, whatever happens next.
    const pending = PENDING.get(known);
    PENDING.delete(known);
    const cookie = cookieValue(req.headers.cookie, BIND_COOKIE);
    if (!pending || !cookie || !nonceMatches(cookie, pending.binding)) {
      return send(403, 'Not connected', 'This sign-in was started in a different browser. Start again from Gatewaze, in this browser.');
    }

    let client;
    try {
      client = await clientCredentials();
    } catch (err) {
      log('could not read settings', { error: (err as Error).message });
      return send(500, 'Not connected', 'The settings could not be read. Start again from Gatewaze in a moment.');
    }
    if (!client) return send(503, 'Not connected', 'The OAuth client is no longer configured.');

    let tokens;
    try {
      tokens = await exchangeCode(client, apiBase, code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'the code could not be exchanged';
      log('code exchange failed', { error: msg });
      return send(400, 'Not connected', msg);
    }

    // Which channel did they actually pick? Google's account chooser is the
    // only place that decision was made, and with two AAIF channels storing
    // the wrong one publishes talks to the wrong audience.
    const channel = await fetchChannel(tokens.accessToken);
    if (!channel) {
      return send(400, 'Not connected', 'Authorised, but the channel could not be read. Does this Google account manage a YouTube channel?');
    }

    const sealed = sealSecret(String(tokens.refreshToken));
    if (!sealed) {
      // Refusing to store a token in the clear is the right failure here.
      log('GATEWAZE_SECRETS_KEY is unavailable — refusing to store the refresh token');
      return send(503, 'Not connected', 'The server cannot seal credentials at the moment, so nothing was stored.');
    }

    // Link to the seeded house-style profile on the same key, so the copy
    // recipes know which voice this channel writes in.
    const { data: profile } = await supabase
      .from('video_channel_profiles')
      .select('id')
      .eq('platform', 'youtube')
      .eq('external_id', channel.id)
      .maybeSingle();

    const { error } = await supabase
      .from('video_platform_connections')
      .upsert({
        platform: 'youtube',
        external_account_id: channel.id,
        label: channel.title,
        channel_profile_id: profile?.id ?? null,
        encrypted_credentials: sealed,
        scopes: tokens.scopes,
        state: 'connected',
        state_detail: null,
        collection_enabled: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'platform,external_account_id' });

    if (error) {
      log('could not store the connection', { error: error.message });
      return send(500, 'Not connected', 'Authorised, but the connection could not be saved.');
    }

    log('channel connected', { channel: channel.id, title: channel.title });
    return send(
      200,
      'Connected',
      `${channel.title} is connected.`,
      `Channel ${channel.id}${profile ? '' : '. No house-style profile matched this channel, so it will use the default voice.'}`,
    );
  });

  /** The connections, without ever selecting the sealed column. */
  router.get('/connections', async (_req: Request, res: Response) => {
    const { data, error } = await supabase
      .from('video_platform_connections')
      .select('id, platform, external_account_id, label, state, state_detail, scopes, collection_enabled, last_collected_at, last_collect_status, last_collect_detail, created_at')
      .eq('platform', 'youtube')
      .order('created_at');
    if (error) {
      log('could not list connections', { error: error.message });
      return res.status(500).json({ error: 'The connections could not be read.' });
    }
    // A disconnected row is history, except when Google never confirmed the
    // revoke: then the grant may still be live, and the operator must see it.
    res.json({
      connections: (data ?? []).map((c: Record<string, unknown>) => ({
        ...c,
        needs_manual_revoke: c.state === 'disconnected' && c.state_detail === DETAIL_REVOKE_UNCONFIRMED,
      })),
    });
  });

  /**
   * Disconnect a channel. The row is kept, not deleted: metrics history
   * cascades from it, and publications and discovered videos point at it.
   * Disconnecting revokes the grant at Google (best effort), drops the sealed
   * refresh token, stops collection, and marks the row 'disconnected', which
   * both workers already skip. Connecting the same channel again goes through
   * the normal flow and upserts this same row back to 'connected'.
   */
  router.post('/connections/:id/disconnect', async (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'No such connection.' });

    const { data: conn, error: readErr } = await supabase
      .from('video_platform_connections')
      .select('id, label, external_account_id, encrypted_credentials, state, updated_at')
      .eq('id', id)
      .eq('platform', 'youtube')
      .maybeSingle();
    if (readErr) {
      log('could not read connection', { error: readErr.message });
      return res.status(500).json({ error: 'The connection could not be read.' });
    }
    if (!conn) return res.status(404).json({ error: 'No such connection.' });
    // Already disconnected and holding nothing: done. Repeating it would
    // overwrite the record of whether the revoke succeeded.
    if (conn.state === 'disconnected' && !conn.encrypted_credentials) return res.json({ ok: true, revoked: null });

    // Revoke before clearing, while we still hold the token. A sealed value
    // that will not unseal cannot be revoked; it is dropped all the same.
    const refreshToken = conn.encrypted_credentials ? unsealSecret(conn.encrypted_credentials) : null;
    const revoked = refreshToken ? await revokeToken(refreshToken) : false;

    let q = supabase
      .from('video_platform_connections')
      .update({
        state: 'disconnected',
        state_detail: revoked ? DETAIL_REVOKED : DETAIL_REVOKE_UNCONFIRMED,
        encrypted_credentials: null,
        collection_enabled: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('platform', 'youtube');
    // Only the row as we read it: a reconnect that landed in between bumped
    // updated_at with a new credential, and that connection stands. Compared
    // on updated_at rather than the sealed credential, so the ciphertext never
    // travels in a request URL (and so never in an access log).
    q = conn.updated_at ? q.eq('updated_at', conn.updated_at) : q.is('updated_at', null);
    const { data: changed, error } = await q.select('id');
    if (error) {
      log('could not disconnect', { error: error.message });
      return res.status(500).json({ error: 'The channel could not be disconnected.' });
    }
    if (!changed?.length) {
      return res.status(409).json({ error: 'The channel was reconnected while disconnecting. Refresh and try again.' });
    }
    log('channel disconnected', { channel: conn.external_account_id, revoked });
    res.json({ ok: true, revoked });
  });

  /**
   * Sync a channel now: queue the discovery job for this one connection with
   * the largest cap the adapter allows, so the whole back catalogue arrives
   * in one run instead of the nightly run's newest 1,000. Uploads already
   * held are adopted, not duplicated, so a repeat is harmless; the job id is
   * bucketed by ten minutes so repeated clicks queue one run, not many.
   */
  router.post('/connections/:id/sync', async (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'No such connection.' });
    if (typeof enqueueJob !== 'function') {
      return res.status(503).json({ error: 'The job queue is not available on this server.' });
    }

    const { data: conn, error: readErr } = await supabase
      .from('video_platform_connections')
      .select('id, state')
      .eq('id', id)
      .eq('platform', 'youtube')
      .maybeSingle();
    if (readErr) {
      log('could not read connection', { error: readErr.message });
      return res.status(500).json({ error: 'The connection could not be read.' });
    }
    if (!conn) return res.status(404).json({ error: 'No such connection.' });
    if (conn.state !== 'connected') {
      return res.status(409).json({ error: 'Only a connected channel can be synced. Connect it again first.' });
    }

    try {
      const job = await enqueueJob(
        'jobs',
        'videos-publisher-youtube:discover-videos',
        { kind: 'videos-publisher-youtube:discover-videos', connection_id: id, cap: SYNC_CAP },
        { jobId: `videos-publisher-youtube-sync-${id}-${Math.floor(Date.now() / SYNC_WINDOW_MS)}` },
      );
      if (!job?.id) return res.status(503).json({ error: 'The sync could not be queued.' });
      log('sync queued', { connection: id, job: job.id });
      res.json({ queued: true, job_id: job.id });
    } catch (err) {
      log('could not queue sync', { error: (err as Error).message });
      res.status(503).json({ error: 'The sync could not be queued.' });
    }
  });

  app.use('/api/modules/videos-publisher-youtube', router);
  // Outside /api/modules on purpose: see the comment at the top of this file.
  app.use(CALLBACK_PATH.replace(/\/oauth\/callback$/, ''), callbackRouter);
  console.log('[videos-publisher-youtube] OAuth routes registered');
}
