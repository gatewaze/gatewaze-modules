import { describe, expect, it } from 'vitest';
import type { DomainResult } from '../mx';
import { ProviderError, type ProviderResult, type VerificationProvider } from '../types';
import { errorKind, sampleBucket, verifyAddress, type ProviderSlot, type VerifyDeps } from '../verify';

const google: DomainResult = { domain: 'acme.com', outcome: 'accepts_mail', mailboxProvider: 'google', mxHost: 'aspmx.l.google.com', error: null };

function fake(answer: (email: string) => ProviderResult | Error): VerificationProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    label: 'Fake', concurrency: 5, calls,
    isConfigured: () => true,
    verify: async (email) => {
      calls.push(email);
      const a = answer(email);
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

const slot = (id: string, provider: VerificationProvider): ProviderSlot => ({ id, provider, config: {} });

function deps(over: Partial<VerifyDeps> = {}, budget = 100): VerifyDeps & { used: Map<string, number> } {
  const used = new Map<string, number>();
  let left = budget;
  return {
    domain: async () => google,
    primary: [],
    escalation: null,
    compare: null,
    inCompareSample: () => false,
    take: (id) => { if (left <= 0) return false; left--; used.set(id, (used.get(id) ?? 0) + 1); return true; },
    giveBack: (id) => { left++; used.set(id, (used.get(id) ?? 1) - 1); },
    stopped: new Set(),
    call: (s, e) => s.provider.verify(e, { config: s.config, unsealSecret: () => null, fetch, signal: new AbortController().signal }),
    used,
    ...over,
  };
}

const ok: ProviderResult = { status: 'valid', reason: 'mailbox_ok' };
const catchAll: ProviderResult = { status: 'risky', reason: 'accept_all' };
const gone: ProviderResult = { status: 'invalid', reason: 'mailbox_not_found' };

describe('verifyAddress with no provider', () => {
  it('decides from DNS at the domain level', async () => {
    const r = await verifyAddress('Jane@Acme.com', deps());
    expect(r.outcome).toEqual({
      email: 'jane@acme.com', status: 'valid', reason: 'domain_accepts_mail', level: 'domain',
      decidedBy: 'builtin', mailboxProvider: 'google', suggestion: null,
    });
    expect(r.paidPending).toBe(false);
  });

  it('stops at a local failure without looking up DNS', async () => {
    let looked = false;
    const r = await verifyAddress('jane@gmial.com', deps({ domain: async () => { looked = true; return google; } }));
    expect(r.outcome).toMatchObject({ status: 'invalid', reason: 'domain_typo', suggestion: 'jane@gmail.com' });
    expect(looked).toBe(false);
  });

  it.each([
    ['not_found', 'domain_not_found'],
    ['null_mx', 'null_mx'],
    ['no_mail_host', 'no_mx'],
  ] as const)('marks a %s domain invalid', async (outcome, reason) => {
    const r = await verifyAddress('jane@acme.com', deps({ domain: async () => ({ ...google, outcome }) }));
    expect(r.outcome).toMatchObject({ status: 'invalid', reason });
  });

  it('marks an address-only domain and a role address risky', async () => {
    expect((await verifyAddress('jane@acme.com', deps({ domain: async () => ({ ...google, outcome: 'address_only' }) }))).outcome)
      .toMatchObject({ status: 'risky', reason: 'no_mx' });
    expect((await verifyAddress('info@acme.com', deps())).outcome).toMatchObject({ status: 'risky', reason: 'role' });
  });

  it('records nothing when DNS did not answer', async () => {
    const r = await verifyAddress('jane@acme.com', deps({ domain: async () => ({ ...google, outcome: 'temporary' }) }));
    expect(r.outcome).toBeNull();
  });
});

describe('verifyAddress with providers', () => {
  it('lets the first provider that answers decide, at the mailbox level', async () => {
    const a = fake(() => gone);
    const r = await verifyAddress('jane@acme.com', deps({ primary: [slot('email-verification-a', a)] }));
    expect(r.outcome).toMatchObject({ status: 'invalid', reason: 'mailbox_not_found', level: 'mailbox', decidedBy: 'email-verification-a', mailboxProvider: 'google' });
  });

  it('never asks a provider about an address the free checks already failed', async () => {
    const a = fake(() => ok);
    await verifyAddress('noreply@acme.com', deps({ primary: [slot('email-verification-a', a)] }));
    expect(a.calls).toEqual([]);
  });

  it('falls back to the next provider on an error, and stops a provider with a bad key for the run', async () => {
    const a = fake(() => new ProviderError('auth', 'Wrong API'));
    const b = fake(() => ok);
    const d = deps({ primary: [slot('email-verification-a', a), slot('email-verification-b', b)] });
    const r1 = await verifyAddress('jane@acme.com', d);
    const r2 = await verifyAddress('joe@acme.com', d);
    expect(r1.outcome?.decidedBy).toBe('email-verification-b');
    expect(r2.outcome?.decidedBy).toBe('email-verification-b');
    expect(a.calls).toEqual(['jane@acme.com']);
    expect(d.stopped.has('email-verification-a')).toBe(true);
    // A failed call is not charged against the limit.
    expect(d.used.get('email-verification-a')).toBe(0);
  });

  it('keeps going to the same provider after a temporary error', async () => {
    let n = 0;
    const a = fake(() => (n++ === 0 ? new ProviderError('temporary', '503') : ok));
    const d = deps({ primary: [slot('email-verification-a', a)] });
    expect((await verifyAddress('jane@acme.com', d)).paidPending).toBe(true);
    expect((await verifyAddress('joe@acme.com', d)).outcome?.level).toBe('mailbox');
  });

  it('falls back to the domain result, marked pending, when the daily limit is used up', async () => {
    const a = fake(() => ok);
    const r = await verifyAddress('jane@acme.com', deps({ primary: [slot('email-verification-a', a)] }, 0));
    expect(r.outcome).toMatchObject({ level: 'domain', reason: 'domain_accepts_mail' });
    expect(r.paidPending).toBe(true);
    expect(a.calls).toEqual([]);
  });

  it('escalates a catch-all answer and takes a definite second answer', async () => {
    const a = fake(() => catchAll);
    const esc = fake(() => gone);
    const r = await verifyAddress('jane@acme.com', deps({ primary: [slot('email-verification-a', a)], escalation: slot('email-verification-esc', esc) }));
    expect(r.outcome).toMatchObject({ status: 'invalid', reason: 'mailbox_not_found', decidedBy: 'email-verification-esc' });
    expect(r.calls.map((c) => c.purpose)).toEqual(['primary', 'escalation']);
  });

  it('keeps the first answer when escalation is also unsure, and does not escalate a definite answer', async () => {
    const esc = fake(() => ({ status: 'risky', reason: 'unknown' }));
    const r = await verifyAddress('jane@acme.com', deps({ primary: [slot('email-verification-a', fake(() => catchAll))], escalation: slot('email-verification-esc', esc) }));
    expect(r.outcome).toMatchObject({ status: 'risky', reason: 'accept_all', decidedBy: 'email-verification-a' });
    const esc2 = fake(() => gone);
    await verifyAddress('joe@acme.com', deps({ primary: [slot('email-verification-a', fake(() => ok))], escalation: slot('email-verification-esc', esc2) }));
    expect(esc2.calls).toEqual([]);
  });

  it('records a compare answer without letting it change the result', async () => {
    const cmp = fake(() => gone);
    const r = await verifyAddress('jane@acme.com', deps({
      primary: [slot('email-verification-a', fake(() => ok))],
      compare: slot('email-verification-cmp', cmp),
      inCompareSample: () => true,
    }));
    expect(r.outcome).toMatchObject({ status: 'valid', decidedBy: 'email-verification-a' });
    expect(r.calls.find((c) => c.purpose === 'compare')?.result).toEqual(gone);
  });

  it('does not escalate a risky answer that is not catch-all or unknown', async () => {
    const esc = fake(() => ok);
    await verifyAddress('jane@acme.com', deps({ primary: [slot('email-verification-a', fake(() => ({ status: 'risky', reason: 'role' })))], escalation: slot('email-verification-esc', esc) }));
    expect(esc.calls).toEqual([]);
  });

  it('does not ask the same provider twice when it is both primary and escalation', async () => {
    const a = fake(() => catchAll);
    const s = slot('email-verification-a', a);
    await verifyAddress('jane@acme.com', deps({ primary: [s], escalation: s }));
    expect(a.calls).toHaveLength(1);
  });

  it('calls the compare provider only for addresses in the sample', async () => {
    const cmp = fake(() => ok);
    await verifyAddress('jane@acme.com', deps({ primary: [slot('email-verification-a', fake(() => ok))], compare: slot('email-verification-cmp', cmp), inCompareSample: () => false }));
    expect(cmp.calls).toEqual([]);
  });

  it('does not call the compare provider again when it already answered as primary', async () => {
    const cmp = fake(() => ok);
    const s = slot('email-verification-cmp', cmp);
    await verifyAddress('jane@acme.com', deps({ primary: [s], compare: s, inCompareSample: () => true }));
    expect(cmp.calls).toHaveLength(1);
  });

  it("passes on the provider's suggestion and cuts long error messages", async () => {
    const r = await verifyAddress('jane@acme.com', deps({ primary: [slot('email-verification-a', fake(() => ({ ...gone, suggestion: 'jane@acme.co' })))] }));
    expect(r.outcome?.suggestion).toBe('jane@acme.co');
    const e = await verifyAddress('jane@acme.com', deps({ primary: [slot('email-verification-a', fake(() => new ProviderError('temporary', 'x'.repeat(500))))] }));
    expect(e.calls[0].error).toHaveLength(200);
  });

  it('keeps a role address risky even when the mailbox exists', async () => {
    const r = await verifyAddress('sales@acme.com', deps({ primary: [slot('email-verification-a', fake(() => ok))] }));
    expect(r.outcome).toMatchObject({ status: 'risky', reason: 'role', level: 'mailbox' });
  });
});

describe('errorKind', () => {
  it('reads the kind from a provider error class of another module', () => {
    class OtherError extends Error { kind = 'credits'; }
    expect(errorKind(new OtherError('x'))).toBe('credits');
    expect(errorKind(Object.assign(new Error('x'), { kind: 'nonsense' }))).toBe('temporary');
    expect(errorKind(new Error('plain'))).toBe('temporary');
  });
});

describe('sampleBucket', () => {
  it('is stable and in range', () => {
    expect(sampleBucket('jane@acme.com')).toBe(sampleBucket('jane@acme.com'));
    for (const e of ['a@b.co', 'x@y.org', 'long.name+tag@sub.example.com']) {
      const b = sampleBucket(e);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });
});
