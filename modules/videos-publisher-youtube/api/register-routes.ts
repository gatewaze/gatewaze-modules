// @ts-nocheck — supabase-js + express are resolved at module-host install time.

/**
 * The connect flow: start, and Google's callback.
 *
 * Mounted under /api/modules/videos-publisher-youtube, which the platform
 * gates to super_admin for everything except /internal/*. That gate is wanted
 * here — this route hands out a URL that grants upload rights to a channel.
 *
 * The callback is the one exception that cannot be behind a bearer token,
 * because Google redirects a BROWSER to it. It is protected by the `state`
 * nonce instead: the start endpoint mints one, stores it, and the callback
 * refuses anything it did not issue. Without that, anyone who guessed the URL
 * could attach their own channel to this install.
 */

import { Router, type Express, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, timingSafeEqual } from 'crypto';

import { authorizeUrl, exchangeCode, fetchChannel, SCOPES } from '../lib/oauth.js';
import { serviceClient } from '../lib/service-client.js';
import { sealSecret, unsealSecret } from '../lib/secret-envelope.js';

/** State nonces, in memory. Short-lived by design. */
const PENDING = new Map<string, { createdAt: number; actor: string | null }>();
const STATE_TTL_MS = 10 * 60 * 1000;

function sweepPending(): void {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, v] of PENDING) if (v.createdAt < cutoff) PENDING.delete(k);
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

export function registerRoutes(app: Express, ctx?: Record<string, unknown>): void {
  const supabase = serviceClient();

  const log = (m: string, meta?: Record<string, unknown>) =>
    console.log(`[videos-publisher-youtube] ${m}`, meta ?? '');

  /** The public API base Google must redirect back to. */
  const apiBase = (process.env.API_URL ?? process.env.API_EXTERNAL_URL ?? '').replace(/\/+$/, '');

  /**
   * The OAuth client, read from this module's own sealed config.
   *
   * Sealed with the platform envelope, so this is decrypted here and never
   * leaves the server. Returns null when unconfigured, which every caller
   * turns into a clear "set the credentials first" rather than a 500.
   */
  async function clientCredentials(): Promise<{ clientId: string; clientSecret: string } | null> {
    const { data } = await supabase
      .from('installed_modules')
      .select('config')
      .eq('id', 'videos-publisher-youtube')
      .maybeSingle();
    const cfg = (data?.config ?? {}) as Record<string, unknown>;
    const clientId = String(cfg.clientId ?? '');
    const rawSecret = String(cfg.clientSecret ?? '');
    if (!clientId || !rawSecret) return null;
    const clientSecret = unsealSecret(rawSecret) ?? rawSecret;
    return { clientId, clientSecret };
  }

  const router = Router();

  // Limiter first, before any handler. /oauth/start performs an authorization
  // check and mints a nonce, and /oauth/callback is reachable by anyone who
  // has the URL, so both need a ceiling that does not depend on the caller
  // being who they say they are. A real operator connects a channel perhaps
  // twice in a session.
  router.use(rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'rate_limited', message: 'too many requests' },
  }));

  /** Where to send the operator's browser to authorise a channel. */
  router.get('/oauth/start', async (_req: Request, res: Response) => {
    const client = await clientCredentials();
    if (!client) {
      return res.status(503).json({
        error: 'The YouTube OAuth client is not configured. Add the client ID and secret on the module’s settings first.',
      });
    }
    if (!apiBase) {
      return res.status(503).json({ error: 'API_URL is not set, so the redirect URI cannot be built.' });
    }

    sweepPending();
    const state = randomBytes(32).toString('base64url');
    PENDING.set(state, { createdAt: Date.now(), actor: null });

    res.json({
      authorize_url: authorizeUrl(client, apiBase, state),
      // So the operator can check it against the console before clicking.
      redirect_uri: `${apiBase}/api/modules/videos-publisher-youtube/oauth/callback`,
      scopes: SCOPES,
      expires_in_seconds: STATE_TTL_MS / 1000,
    });
  });

  /**
   * Google's redirect lands here, in a browser, with no bearer token.
   *
   * The `state` nonce is the whole authorisation: it was minted by a
   * super_admin-gated endpoint moments ago and is single-use.
   */
  router.get('/oauth/callback', async (req: Request, res: Response) => {
    const send = (code: number, title: string, ...paragraphs: string[]) =>
      res.status(code).type('html').send(page(title, paragraphs));

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
    PENDING.delete(known);

    const client = await clientCredentials();
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
    if (error) return res.status(500).json({ error: error.message });
    res.json({ connections: data ?? [] });
  });

  app.use('/api/modules/videos-publisher-youtube', router);
  console.log('[videos-publisher-youtube] OAuth routes registered');
}
