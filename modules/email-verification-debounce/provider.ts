/**
 * Debounce (debounce.com) mailbox checks for the email-verification module.
 *
 * Single validation: GET https://api.debounce.io/v1/?api=<key>&email=<address>.
 * A private key allows 5 calls at once. Result codes (help.debounce.com,
 * "Result Codes"): 1 syntax, 2 spam trap, 3 disposable, 4 accept-all,
 * 5 valid, 6 invalid, 7 unknown. Code 8 (role) is not sent by the API; the
 * `role` field says it instead. The documented sample nests the fields under
 * `debounce` with string values while the schema is flat with numbers, so
 * both shapes are read.
 *
 * The API key travels in the query string, as Debounce requires, so the URL
 * is never logged or put in an error message.
 *
 * The provider is written without imports so the core worker can load it
 * from any module root.
 */

const ENDPOINT = 'https://api.debounce.io/v1/';

type Status = 'valid' | 'risky' | 'invalid';
type ErrorKind = 'auth' | 'credits' | 'rate_limit' | 'temporary' | 'bad_response';

class DebounceError extends Error {
  // The core module checks `kind`, so this need not be its ProviderError class.
  constructor(public readonly kind: ErrorKind, message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

interface Ctx {
  config: Record<string, unknown>;
  unsealSecret: (value: unknown) => string | null;
  fetch: typeof fetch;
  signal: AbortSignal;
}

const CODES: Record<string, { status: Status; reason: string }> = {
  '1': { status: 'invalid', reason: 'syntax' },
  '2': { status: 'invalid', reason: 'spam_trap' },
  '3': { status: 'invalid', reason: 'disposable' },
  '4': { status: 'risky', reason: 'accept_all' },
  '5': { status: 'valid', reason: 'mailbox_ok' },
  '6': { status: 'invalid', reason: 'mailbox_not_found' },
  '7': { status: 'risky', reason: 'unknown' },
  '8': { status: 'risky', reason: 'role' },
};

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

function apiKey(ctx: Pick<Ctx, 'config' | 'unsealSecret'>): string | null {
  const key = ctx.unsealSecret(ctx.config.DEBOUNCE_API_KEY);
  return key && key.trim() ? key.trim() : null;
}

function errorText(body: Record<string, unknown>): string {
  const inner = (body.debounce ?? {}) as Record<string, unknown>;
  return String(body.error ?? body.message ?? inner.error ?? '').slice(0, 200);
}

export function interpret(body: unknown): { status: Status; reason: string; suggestion: string | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  const d = (b.debounce && typeof b.debounce === 'object' ? b.debounce : b) as Record<string, unknown>;
  const code = d.code === undefined || d.code === null ? '' : String(d.code).trim();
  const mapped = CODES[code];
  if (!mapped) throw new DebounceError('bad_response', `Debounce returned no known result code (${code || 'none'})`);
  const suggestion = typeof d.did_you_mean === 'string' && d.did_you_mean.includes('@') ? d.did_you_mean.trim().toLowerCase() : null;
  // A deliverable role address is still a team inbox.
  if (mapped.status === 'valid' && truthy(d.role)) return { status: 'risky', reason: 'role', suggestion };
  return { ...mapped, suggestion };
}

const provider = {
  label: 'Debounce',
  concurrency: 5,

  isConfigured(ctx: Pick<Ctx, 'config' | 'unsealSecret'>): boolean {
    return apiKey(ctx) !== null;
  },

  async verify(email: string, ctx: Ctx) {
    const key = apiKey(ctx);
    if (!key) throw new DebounceError('auth', 'No Debounce API key is set');
    const params = new URLSearchParams({ api: key, email });
    if (truthy(ctx.config.gsuite)) params.set('gsuite', 'true');

    let res: Response;
    try {
      res = await ctx.fetch(`${ENDPOINT}?${params.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: ctx.signal,
        redirect: 'error',
      });
    } catch (e) {
      throw new DebounceError('temporary', `Debounce could not be reached: ${(e as Error)?.name ?? 'error'}`);
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      if (res.ok) throw new DebounceError('bad_response', 'Debounce returned a response that is not JSON');
    }

    // Error text is stored with the result, so never let it carry the key.
    const text = errorText(body).split(key).join('***');
    if (res.status === 401 || /wrong api|invalid api|authentication failed/i.test(text)) throw new DebounceError('auth', `Debounce rejected the API key (${res.status})`);
    if (res.status === 402 || /credits? low|insufficient|balance/i.test(text)) throw new DebounceError('credits', `Debounce is out of credits (${res.status})`);
    if (res.status === 429) throw new DebounceError('rate_limit', `Debounce rate limit: ${text || res.status}`);
    if (res.status >= 500) throw new DebounceError('temporary', `Debounce returned ${res.status}`);
    if (!res.ok) throw new DebounceError('bad_response', `Debounce returned ${res.status}: ${text}`);
    if (String(body.success ?? '1') === '0') throw new DebounceError('bad_response', `Debounce did not validate the address: ${text || 'no reason given'}`);

    const r = interpret(body);
    const d = (body.debounce && typeof body.debounce === 'object' ? body.debounce : body) as Record<string, unknown>;
    return {
      ...r,
      // Keep what Debounce said about the address, not the account balance.
      raw: { code: d.code ?? null, result: d.result ?? null, reason: d.reason ?? null, role: d.role ?? null, free_email: d.free_email ?? null, did_you_mean: d.did_you_mean ?? null },
    };
  },
};

export default provider;
