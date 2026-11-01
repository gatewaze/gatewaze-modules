import { describe, expect, it, vi } from 'vitest';
import { loadProviders, providerPaths } from '../load-providers';
import { verifyAddress } from '../verify';

describe('providerPaths', () => {
  it('looks beside the core module first, then in the module roots', () => {
    const paths = providerPaths('email-verification-debounce', '/repo/modules/email-verification');
    expect(paths[0]).toBe('/repo/modules/email-verification-debounce/provider.ts');
    expect(paths).toContain('/gatewaze-modules/modules/email-verification-debounce/provider.ts');
  });
});

describe('loadProviders', () => {
  it('loads the Debounce provider module from the same repository', async () => {
    const [p] = await loadProviders([{ id: 'email-verification-debounce', config: { DEBOUNCE_API_KEY: 'k' } }]);
    expect(p?.provider.label).toBe('Debounce');
    expect(p.provider.isConfigured({ config: p.config, unsealSecret: (v) => (typeof v === 'string' ? v : null) })).toBe(true);
  });

  it('skips ids that are not provider ids and providers that do not exist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await loadProviders([
      { id: 'email-verification', config: {} },
      { id: 'email-verification-../../etc', config: {} },
      { id: 'email-verification-nope', config: {} },
    ]);
    expect(out).toEqual([]);
    warn.mockRestore();
  });

  it('runs a real provider through the decision sequence, including its error kinds', async () => {
    const [p] = await loadProviders([{ id: 'email-verification-debounce', config: { DEBOUNCE_API_KEY: 'k' } }]);
    const slot = { id: p.id, provider: p.provider, config: p.config };
    const respond = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
    const run = (fetchImpl: typeof fetch, stopped = new Set<string>()) => verifyAddress('jane@acme.com', {
      domain: async () => ({ domain: 'acme.com', outcome: 'accepts_mail', mailboxProvider: 'microsoft', mxHost: 'x.protection.outlook.com', error: null }),
      primary: [slot], escalation: null, compare: null, inCompareSample: () => false,
      take: () => true, giveBack: () => {}, stopped,
      call: (s, e) => s.provider.verify(e, { config: s.config, unsealSecret: (v) => String(v), fetch: fetchImpl, signal: new AbortController().signal }),
    });

    const good = await run(respond({ debounce: { code: '6', role: 'false', did_you_mean: '' }, success: '1' }) as typeof fetch);
    expect(good.outcome).toMatchObject({ status: 'invalid', reason: 'mailbox_not_found', level: 'mailbox', mailboxProvider: 'microsoft' });

    const stopped = new Set<string>();
    const noCredits = await run(respond({ error: 'Credits Low', success: '0' }, 402) as typeof fetch, stopped);
    expect(noCredits.outcome).toMatchObject({ level: 'domain' });
    expect(noCredits.paidPending).toBe(true);
    expect(stopped.has('email-verification-debounce')).toBe(true);
  });
});
