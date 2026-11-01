import { describe, expect, it } from 'vitest';
import provider, { interpret } from '../provider';

const KEY = 'test-key-123';

function ctx(respond: (url: URL) => Response | Promise<Response>, config: Record<string, unknown> = { DEBOUNCE_API_KEY: KEY }) {
  const seen: URL[] = [];
  return {
    seen,
    ctx: {
      config,
      unsealSecret: (v: unknown) => (typeof v === 'string' && v ? v : null),
      fetch: (async (input: RequestInfo | URL) => {
        const u = new URL(String(input));
        seen.push(u);
        return respond(u);
      }) as typeof fetch,
      signal: new AbortController().signal,
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sample = (code: string, extra: Record<string, string> = {}) => ({
  debounce: { email: 'jane@acme.com', code, role: 'false', free_email: 'false', result: 'x', reason: 'x', send_transactional: '1', did_you_mean: '', ...extra },
  success: '1',
  balance: '14999',
});

describe('interpret', () => {
  it.each([
    ['1', 'invalid', 'syntax'], ['2', 'invalid', 'spam_trap'], ['3', 'invalid', 'disposable'],
    ['4', 'risky', 'accept_all'], ['5', 'valid', 'mailbox_ok'], ['6', 'invalid', 'mailbox_not_found'], ['7', 'risky', 'unknown'],
  ])('maps code %s', (code, status, reason) => {
    expect(interpret(sample(code))).toMatchObject({ status, reason });
  });

  it('reads the flat schema with numbers too', () => {
    expect(interpret({ email: 'a@b.co', code: 5, role: false, success: 1 })).toMatchObject({ status: 'valid' });
  });

  it('treats a deliverable role address as risky, and passes on a typo suggestion', () => {
    expect(interpret(sample('5', { role: 'true' }))).toMatchObject({ status: 'risky', reason: 'role' });
    expect(interpret(sample('6', { did_you_mean: 'Jane@Gmail.com' })).suggestion).toBe('jane@gmail.com');
  });

  it('refuses an unknown code rather than guessing', () => {
    expect(() => interpret(sample('9'))).toThrow(/no known result code/);
  });
});

describe('provider', () => {
  it('is configured only with a key', () => {
    expect(provider.isConfigured({ config: {}, unsealSecret: () => null })).toBe(false);
    expect(provider.isConfigured({ config: { DEBOUNCE_API_KEY: KEY }, unsealSecret: (v) => String(v) })).toBe(true);
  });

  it('calls the documented endpoint and keeps the balance out of the stored answer', async () => {
    const { ctx: c, seen } = ctx(() => json(sample('5')));
    const r = await provider.verify('jane@acme.com', c);
    expect(seen[0].origin + seen[0].pathname).toBe('https://api.debounce.io/v1/');
    expect(seen[0].searchParams.get('api')).toBe(KEY);
    expect(seen[0].searchParams.get('email')).toBe('jane@acme.com');
    expect(seen[0].searchParams.has('gsuite')).toBe(false);
    expect(r).toMatchObject({ status: 'valid', reason: 'mailbox_ok' });
    expect(JSON.stringify(r.raw)).not.toContain('14999');
  });

  it('sends the gsuite option when it is on', async () => {
    const { ctx: c, seen } = ctx(() => json(sample('4')), { DEBOUNCE_API_KEY: KEY, gsuite: true });
    await provider.verify('jane@acme.com', c);
    expect(seen[0].searchParams.get('gsuite')).toBe('true');
  });

  it.each([
    [401, { error: 'Wrong API', success: '0' }, 'auth'],
    [402, { error: 'Credits Low', success: '0' }, 'credits'],
    [429, { error: 'Maximum concurrent calls reached', success: '0' }, 'rate_limit'],
    [503, {}, 'temporary'],
    [200, { debounce: { error: 'Wrong API' }, success: '0' }, 'auth'],
    [400, { error: `Bad request for key ${KEY}`, success: '0' }, 'bad_response'],
  ])('turns HTTP %s into a %s error without exposing the key', async (status, body, kind) => {
    const { ctx: c } = ctx(() => json(body, status as number));
    const err = await provider.verify('jane@acme.com', c).catch((e) => e);
    expect(err.kind).toBe(kind);
    expect(String(err.message)).not.toContain(KEY);
  });

  it('reports a network failure as temporary without the URL', async () => {
    const { ctx: c } = ctx(() => { throw new TypeError(`fetch failed for https://api.debounce.io/v1/?api=${KEY}`); });
    const err = await provider.verify('jane@acme.com', c).catch((e) => e);
    expect(err.kind).toBe('temporary');
    expect(String(err.message)).not.toContain(KEY);
  });
});
