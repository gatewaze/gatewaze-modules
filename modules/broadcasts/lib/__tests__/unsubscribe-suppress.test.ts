import { describe, expect, it } from 'vitest';
import { recordUnsubscribe, unsubscribeStatus, unsubscribeStep } from '../../functions/_shared/unsubscribe-suppress';

type Err = { code?: string; message?: string } | null;
type Call = { op: string; args: unknown[] };

/** insertErrors: one entry per insert call, in order. */
function fakeClient(insertErrors: Err[], update: { rows?: number; error?: { message: string } | null } = {}) {
  const calls: Call[] = [];
  let inserts = 0;
  return {
    calls,
    from: (table: string) => ({
      insert: (row: unknown) => {
        calls.push({ op: 'insert', args: [table, row] });
        return Promise.resolve({ error: insertErrors[inserts++] ?? null });
      },
      update: (row: unknown) => {
        calls.push({ op: 'update', args: [row] });
        const q: Record<string, unknown> = {
          eq: (...args: unknown[]) => { calls.push({ op: 'eq', args }); return q; },
          select: () => Promise.resolve({
            data: update.error ? null : Array.from({ length: update.rows ?? 0 }, (_, i) => ({ id: i })),
            error: update.error ?? null,
          }),
        };
        return q;
      },
    }),
  };
}

const dup = { code: '23505', message: 'duplicate key' };

describe('recordUnsubscribe', () => {
  it('inserts a lower-cased suppression with a plain insert, not an upsert on a missing constraint', async () => {
    const c = fakeClient([null]);
    expect(await recordUnsubscribe(c, ' Jane@Acme.com ', 'broadcasts')).toEqual({ ok: true, alreadySuppressed: false });
    expect(c.calls).toEqual([{ op: 'insert', args: ['broadcast_suppressions', { email: 'jane@acme.com', topic: 'broadcasts', source: 'one_click_unsubscribe', reason: 'recipient unsubscribed' }] }]);
  });

  it('takes over an email-verification row on a duplicate, matching the exact address', async () => {
    const c = fakeClient([dup], { rows: 1 });
    expect(await recordUnsubscribe(c, 'a*b_c@acme.com', 'all')).toEqual({ ok: true, alreadySuppressed: true });
    expect(c.calls.find((x) => x.op === 'update')?.args[0]).toEqual({ source: 'one_click_unsubscribe', reason: 'recipient unsubscribed' });
    expect(c.calls.filter((x) => x.op === 'eq').map((x) => x.args)).toEqual([['email', 'a*b_c@acme.com'], ['topic', 'all'], ['source', 'email-verification']]);
    expect(c.calls.filter((x) => x.op === 'insert')).toHaveLength(1);
  });

  it('is done when the duplicate is an unsubscribe or manual row (the retry also hits a duplicate)', async () => {
    const c = fakeClient([dup, dup], { rows: 0 });
    expect(await recordUnsubscribe(c, 'jane@acme.com', 'broadcasts')).toEqual({ ok: true, alreadySuppressed: true });
  });

  it('inserts again when the row was lifted between the insert and the takeover', async () => {
    const c = fakeClient([dup, null], { rows: 0 });
    expect(await recordUnsubscribe(c, 'jane@acme.com', 'all')).toEqual({ ok: true, alreadySuppressed: false });
    expect(c.calls.filter((x) => x.op === 'insert')).toHaveLength(2);
  });

  it('reports an insert error other than a duplicate instead of claiming success', async () => {
    const msg = 'there is no unique or exclusion constraint matching the ON CONFLICT specification';
    expect(await recordUnsubscribe(fakeClient([{ code: '42P10', message: msg }]), 'jane@acme.com', 'broadcasts')).toEqual({ ok: false, error: msg });
    expect(await recordUnsubscribe(fakeClient([dup, { code: '57014', message: 'timeout' }], { rows: 0 }), 'jane@acme.com', 'all')).toEqual({ ok: false, error: 'timeout' });
  });

  it('reports a failed takeover', async () => {
    expect(await recordUnsubscribe(fakeClient([dup], { error: { message: 'update failed' } }), 'jane@acme.com', 'all')).toEqual({ ok: false, error: 'update failed' });
  });
});

describe('unsubscribeStep', () => {
  it('only shows a confirm page for a GET, so link scanners unsubscribe nobody', () => {
    expect(unsubscribeStep('GET', '')).toEqual({ action: 'confirm-page' });
  });

  it('saves on the RFC 8058 one-click POST and answers JSON', () => {
    expect(unsubscribeStep('POST', 'List-Unsubscribe=One-Click')).toEqual({ action: 'suppress', reply: 'json' });
    expect(unsubscribeStep('POST', '')).toEqual({ action: 'suppress', reply: 'json' });
  });

  it('saves on the confirm button and answers with a page', () => {
    expect(unsubscribeStep('POST', 'confirm=1')).toEqual({ action: 'suppress', reply: 'html' });
  });

  it('rejects other methods', () => {
    expect(unsubscribeStep('PUT', '')).toEqual({ action: 'reject' });
  });
});

describe('unsubscribeStatus', () => {
  it('is 500 when nothing was saved, so the person is never told they are unsubscribed', () => {
    expect(unsubscribeStatus({ ok: true, alreadySuppressed: false })).toBe(200);
    expect(unsubscribeStatus({ ok: false, error: 'x' })).toBe(500);
  });
});
