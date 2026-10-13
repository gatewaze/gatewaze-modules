import { describe, it, expect } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
// @ts-expect-error — plain ESM libs, no type declarations
import { authorizeUrl, checkState, classifySlackError, requireSignedIn, slackErrorCode, delayMs, escapeSlackText, isWelcomable, renderWelcomeMessage, signState, verifySlackSignature, DEFAULT_MESSAGE, STATE_TTL_MS, USER_SCOPES } from '../lib/welcome.js';
// @ts-expect-error — plain ESM lib
import { isSealed, sealSecret, unsealSecret } from '../lib/secret-envelope.js';
// @ts-expect-error — plain ESM lib
import { sendDirectMessage, slackApi } from '../lib/welcome-store.js';

const SECRET = 'signing-secret-123';
const NOW = Date.UTC(2026, 9, 13, 14, 0, 0);
const sign = (ts: string, body: string, secret = SECRET) =>
  'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');

describe('verifySlackSignature', () => {
  const ts = String(Math.floor(NOW / 1000));
  const body = '{"type":"event_callback","event":{"type":"team_join"}}';

  it('accepts a correctly signed request (string or Buffer body)', () => {
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sign(ts, body), rawBody: body, now: NOW })).toEqual({ ok: true });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sign(ts, body), rawBody: Buffer.from(body), now: NOW }).ok).toBe(true);
  });

  it('rejects a body changed after signing', () => {
    const r = verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sign(ts, body), rawBody: body.replace('team_join', 'team_joim'), now: NOW });
    expect(r).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects a signature made with another secret', () => {
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sign(ts, body, 'other'), rawBody: body, now: NOW }).ok).toBe(false);
  });

  it('rejects a replay outside the five-minute window, either direction', () => {
    const old = String(Math.floor(NOW / 1000) - 301);
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: old, signature: sign(old, body), rawBody: body, now: NOW })).toEqual({ ok: false, reason: 'stale timestamp' });
    const future = String(Math.floor(NOW / 1000) + 301);
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: future, signature: sign(future, body), rawBody: body, now: NOW }).ok).toBe(false);
  });

  it('fails closed when anything is missing', () => {
    expect(verifySlackSignature({ signingSecret: '', timestamp: ts, signature: sign(ts, body), rawBody: body, now: NOW }).ok).toBe(false);
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: undefined, signature: sign(ts, body), rawBody: body, now: NOW }).ok).toBe(false);
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: undefined, rawBody: body, now: NOW }).ok).toBe(false);
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sign(ts, body), rawBody: undefined, now: NOW }).ok).toBe(false);
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: '12ab', signature: sign(ts, body), rawBody: body, now: NOW }).ok).toBe(false);
  });

  it('does not throw on a signature of the wrong length', () => {
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: 'v0=short', rawBody: body, now: NOW }).ok).toBe(false);
  });
});

describe('signState / checkState', () => {
  const CS = 'client-secret';

  it('round-trips the admin and the expected Slack user', () => {
    const s = signState({ u: 'admin-1', x: 'U123' }, CS, NOW);
    expect(checkState(s, CS, NOW + 1000)).toEqual({ ok: true, state: { u: 'admin-1', x: 'U123', t: null, iat: NOW } });
  });

  it('refuses a state signed with another secret', () => {
    expect(checkState(signState({ u: 'a', x: 'U1' }, 'other', NOW), CS, NOW)).toEqual({ ok: false, reason: 'bad signature' });
  });

  it('refuses a payload edited to name a different account', () => {
    const s = signState({ u: 'a', x: 'U1' }, CS, NOW);
    const [, sig] = s.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, u: 'a', x: 'U999', iat: NOW, n: 'z' })).toString('base64url');
    expect(checkState(`${forged}.${sig}`, CS, NOW).ok).toBe(false);
  });

  it('expires after the TTL and refuses one from the future', () => {
    const s = signState({ u: 'a', x: 'U1' }, CS, NOW);
    expect(checkState(s, CS, NOW + STATE_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
    expect(checkState(signState({ u: 'a', x: 'U1' }, CS, NOW + 5 * 60_000), CS, NOW).ok).toBe(false);
  });

  it('refuses junk without throwing', () => {
    for (const junk of ['', 'abc', 'a.b.c', 'not base64!.x', null, 42, 'x'.repeat(3000)]) {
      expect(checkState(junk, CS, NOW).ok).toBe(false);
    }
  });

  it('will not sign without a secret or without both parties', () => {
    expect(() => signState({ u: 'a', x: 'U1' }, '', NOW)).toThrow();
    expect(() => signState({ u: 'a', x: '' }, CS, NOW)).toThrow();
  });

  it('builds an authorize link for user scopes only', () => {
    const url = new URL(authorizeUrl({ clientId: 'C1', redirectUri: 'https://api.example/cb', state: 'st', teamId: 'T1' }));
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('user_scope')).toBe(USER_SCOPES.join(','));
    expect(url.searchParams.has('scope')).toBe(false); // the bot install is never touched
    expect(url.searchParams.get('team')).toBe('T1');
  });
});

describe('renderWelcomeMessage', () => {
  it('uses the generic default, filled in, when no template is set', () => {
    const user = { id: 'U1', profile: { first_name: 'Ada' } };
    expect(renderWelcomeMessage('', user)).toBe(DEFAULT_MESSAGE.replace('{first_name}', 'Ada'));
    expect(DEFAULT_MESSAGE).not.toMatch(/I started this community/); // brand text lives in config, not here
  });

  it('does not treat $ patterns in a name as replacement patterns', () => {
    const user = { id: 'U1', profile: { first_name: "$&$'$`$1", real_name: '$$ Bill' } };
    expect(renderWelcomeMessage('Hi {first_name} / {name}', user)).toBe("Hi $&amp;$'$`$1 / $$ Bill");
  });

  it('fills placeholders from the profile', () => {
    const user = { id: 'U1', profile: { first_name: 'Ada', real_name: 'Ada Lovelace' } };
    expect(renderWelcomeMessage('Hi {first_name} ({name})!', user)).toBe('Hi Ada (Ada Lovelace)!');
  });

  it('falls back to "there" with no name', () => {
    expect(renderWelcomeMessage('Hi {first_name}', { id: 'U1', profile: {} })).toBe('Hi there');
  });

  it('escapes a joiner-controlled name so it cannot become a mention or link', () => {
    const user = { id: 'U1', profile: { first_name: '<!channel>', real_name: '<https://evil|x> & co' } };
    expect(renderWelcomeMessage('{first_name} {name}', user)).toBe('&lt;!channel&gt; &lt;https://evil|x&gt; &amp; co');
  });

  it('leaves the admin template formatting as written', () => {
    expect(renderWelcomeMessage('*Welcome* <#C123|general>', { id: 'U1', profile: {} })).toBe('*Welcome* <#C123|general>');
  });

  it('escapes exactly Slack’s three control characters', () => {
    expect(escapeSlackText('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d "e"');
  });
});

describe('isWelcomable', () => {
  it('welcomes a normal member', () => expect(isWelcomable({ id: 'U1' }, 'USENDER')).toEqual({ ok: true }));
  it.each([
    [{ id: 'USLACKBOT' }, 'slackbot'],
    [{ id: 'U2', is_bot: true }, 'bot'],
    [{ id: 'U3', is_app_user: true }, 'bot'],
    [{ id: 'U4', deleted: true }, 'deactivated'],
    [{ id: 'USENDER' }, 'is the sender'],
    [{}, 'no user'],
  ])('skips %j', (user, reason) => expect(isWelcomable(user, 'USENDER')).toEqual({ ok: false, reason }));
});

describe('delayMs', () => {
  it('converts minutes and clamps', () => {
    expect(delayMs(5)).toBe(300_000);
    expect(delayMs(0)).toBe(0);
    expect(delayMs(99999)).toBe(24 * 60 * 60_000);
    expect(delayMs('nope')).toBe(300_000);
    expect(delayMs(-3)).toBe(300_000);
  });
});

describe('classifySlackError', () => {
  it('separates a dead connection, an unreachable person and a transient failure', () => {
    expect(classifySlackError('token_revoked')).toBe('auth');
    expect(classifySlackError('missing_scope')).toBe('auth');
    expect(classifySlackError('cannot_dm_bot')).toBe('permanent');
    expect(classifySlackError('user_not_found')).toBe('permanent');
    expect(classifySlackError('ratelimited')).toBe('retry');
    expect(classifySlackError('network_error')).toBe('retry');
    expect(classifySlackError('something_new')).toBe('retry');
  });
});

describe('secret envelope', () => {
  const env = { GATEWAZE_SECRETS_KEY: randomBytes(32).toString('base64') };

  it('round-trips a token', () => {
    const sealed = sealSecret('xoxp-123', env);
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain('xoxp');
    expect(unsealSecret(sealed, env)).toBe('xoxp-123');
  });

  it('refuses to seal without a key, rather than returning plaintext', () => {
    expect(sealSecret('xoxp-123', {})).toBeNull();
    expect(sealSecret('xoxp-123', { GATEWAZE_SECRETS_KEY: 'too-short' })).toBeNull();
  });

  it('reads a value sealed under the previous key during rotation', () => {
    const old = { GATEWAZE_SECRETS_KEY: randomBytes(32).toString('base64') };
    const sealed = sealSecret('xoxp-old', old);
    expect(unsealSecret(sealed, { GATEWAZE_SECRETS_KEY: env.GATEWAZE_SECRETS_KEY, GATEWAZE_SECRETS_KEY_OLD: old.GATEWAZE_SECRETS_KEY })).toBe('xoxp-old');
    expect(unsealSecret(sealed, env)).toBeNull();
  });
});

describe('slackApi / sendDirectMessage', () => {
  type Call = { url: string; body: URLSearchParams; auth: string | null };
  function fakeSlack(responses: Record<string, unknown>, calls: Call[] = []) {
    const impl = async (url: string, init: RequestInit) => {
      const method = url.split('/api/')[1];
      calls.push({ url, body: init.body as URLSearchParams, auth: (init.headers as Record<string, string>).Authorization ?? null });
      const r = responses[method];
      if (r === 429) return { status: 429, headers: new Headers({ 'retry-after': '30' }), json: async () => ({}) } as unknown as Response;
      return { status: 200, headers: new Headers(), json: async () => r } as unknown as Response;
    };
    return { impl, calls };
  }

  it('opens the DM and posts in it with the sender token', async () => {
    const { impl, calls } = fakeSlack({
      'conversations.open': { ok: true, channel: { id: 'D42' } },
      'chat.postMessage': { ok: true, ts: '1.2' },
    });
    const r = await sendDirectMessage('xoxp-s', 'U9', 'hello', impl);
    expect(r).toEqual({ ok: true, channel: 'D42', ts: '1.2' });
    expect(calls.map((c) => c.url.split('/api/')[1])).toEqual(['conversations.open', 'chat.postMessage']);
    expect(calls.every((c) => c.auth === 'Bearer xoxp-s')).toBe(true);
    expect(calls[0].body.get('users')).toBe('U9');
    expect(calls[1].body.get('channel')).toBe('D42');
    expect(calls[1].body.get('text')).toBe('hello');
  });

  it('reports which stage failed and never posts when the open fails', async () => {
    const { impl, calls } = fakeSlack({ 'conversations.open': { ok: false, error: 'cannot_dm_bot' } });
    expect(await sendDirectMessage('t', 'U9', 'x', impl)).toEqual({ ok: false, error: 'cannot_dm_bot', stage: 'open' });
    expect(calls).toHaveLength(1);
  });

  it('turns HTTP 429 into a retryable ratelimited error', async () => {
    const { impl } = fakeSlack({ 'chat.postMessage': 429 });
    expect(await slackApi('chat.postMessage', 't', {}, impl)).toEqual({ ok: false, error: 'ratelimited', retryAfter: 30 });
  });

  it('turns a network failure into an error code instead of throwing', async () => {
    const impl = async () => { throw new Error('ECONNRESET'); };
    expect((await slackApi('auth.test', 't', {}, impl)).error).toBe('network_error');
  });
});

describe('state workspace binding', () => {
  it('carries the workspace id through when given', () => {
    const st = signState({ u: 'admin', x: 'U1', t: 'T1' }, 'secret');
    const r = checkState(st, 'secret');
    expect(r.ok && r.state.t).toBe('T1');
  });
  it('reports no workspace for a state signed without one', () => {
    const r = checkState(signState({ u: 'admin', x: 'U1' }, 'secret'), 'secret');
    expect(r.ok && r.state.t).toBe(null);
  });
  it('links stay valid for a day, not longer', () => {
    const now = Date.now();
    const st = signState({ u: 'a', x: 'U1' }, 's', now);
    expect(checkState(st, 's', now + STATE_TTL_MS - 1000).ok).toBe(true);
    expect(checkState(st, 's', now + 25 * 3600 * 1000)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('slackErrorCode', () => {
  it('passes a Slack error code through', () => expect(slackErrorCode('access_denied')).toBe('access_denied'));
  it.each(['<script>', 'a b', '', 'x'.repeat(65), undefined, ['access_denied']])('replaces %j', (v) =>
    expect(slackErrorCode(v)).toBe('unknown_error'));
});

describe('requireSignedIn', () => {
  const run = (req: Record<string, unknown>) => {
    let status = 0; let nexted = false;
    const res = { status(c: number) { status = c; return { json: () => undefined }; } };
    requireSignedIn(req, res, () => { nexted = true; });
    return { status, nexted };
  };
  it('lets a signed-in request through', () => expect(run({ userId: 'u-1' })).toEqual({ status: 0, nexted: true }));
  it.each([{}, { userId: '' }, { userId: 123 }])('refuses %j with 401', (req) =>
    expect(run(req)).toEqual({ status: 401, nexted: false }));
});
