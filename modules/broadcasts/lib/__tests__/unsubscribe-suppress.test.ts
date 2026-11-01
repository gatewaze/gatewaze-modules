import { describe, expect, it } from 'vitest';
import { recordUnsubscribe } from '../../functions/_shared/unsubscribe-suppress';

type Call = { op: string; args: unknown[] };

function fakeClient(insertError: { code?: string; message?: string } | null, updateError: { message: string } | null = null) {
  const calls: Call[] = [];
  const chain = (op: string, result: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ['ilike', 'eq']) {
      q[m] = (...args: unknown[]) => { calls.push({ op: m, args }); return q; };
    }
    q.then = (resolve: (v: unknown) => void) => resolve(result);
    calls.push({ op, args: [] });
    return q;
  };
  return {
    calls,
    from: (table: string) => ({
      insert: (row: unknown) => { calls.push({ op: 'insert', args: [table, row] }); return Promise.resolve({ error: insertError }); },
      update: (row: unknown) => { calls.push({ op: 'update-row', args: [row] }); return chain('update', { error: updateError }); },
    }),
  };
}

describe('recordUnsubscribe', () => {
  it('inserts a lower-cased suppression with a plain insert, not an upsert on a missing constraint', async () => {
    const c = fakeClient(null);
    expect(await recordUnsubscribe(c, ' Jane@Acme.com ', 'broadcasts')).toEqual({ ok: true, alreadySuppressed: false });
    expect(c.calls[0]).toEqual({ op: 'insert', args: ['broadcast_suppressions', { email: 'jane@acme.com', topic: 'broadcasts', source: 'one_click_unsubscribe', reason: 'recipient unsubscribed' }] });
    expect(c.calls.some((x) => x.op === 'update')).toBe(false);
  });

  it('treats a duplicate as already suppressed and takes over an email-verification row', async () => {
    const c = fakeClient({ code: '23505', message: 'duplicate key' });
    expect(await recordUnsubscribe(c, 'jane_doe@acme.com', 'all')).toEqual({ ok: true, alreadySuppressed: true });
    expect(c.calls.find((x) => x.op === 'update-row')?.args[0]).toEqual({ source: 'one_click_unsubscribe', reason: 'recipient unsubscribed' });
    expect(c.calls.filter((x) => x.op === 'ilike')[0].args).toEqual(['email', 'jane\\_doe@acme.com']);
    expect(c.calls.filter((x) => x.op === 'eq').map((x) => x.args)).toEqual([['topic', 'all'], ['source', 'email-verification']]);
  });

  it('does not run a wildcard update for an address containing *', async () => {
    const c = fakeClient({ code: '23505' });
    expect(await recordUnsubscribe(c, 'a*b@acme.com', 'all')).toEqual({ ok: true, alreadySuppressed: true });
    expect(c.calls.some((x) => x.op === 'update')).toBe(false);
  });

  it('reports any other insert error instead of claiming success', async () => {
    const c = fakeClient({ code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' });
    expect(await recordUnsubscribe(c, 'jane@acme.com', 'broadcasts')).toEqual({ ok: false, error: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' });
  });

  it('reports a failed takeover', async () => {
    const c = fakeClient({ code: '23505' }, { message: 'update failed' });
    expect(await recordUnsubscribe(c, 'jane@acme.com', 'all')).toEqual({ ok: false, error: 'update failed' });
  });
});
