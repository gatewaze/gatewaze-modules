import { describe, it, expect } from 'vitest';
import { finalizeStranded, STRANDED_AFTER_MS } from '../worker/send-engine/engine';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const OLD = new Date(NOW - STRANDED_AFTER_MS - 60_000).toISOString();
const FRESH = new Date(NOW - 60_000).toISOString();

type Row = Record<string, any>;
type Err = { message: string } | null;

// Minimal PostgREST-shaped fake: filters eq / in / lt, head counts, single, update.
function fakeDb(tables: Record<string, Row[]>, fail: { updateSends?: Err; countRecipients?: Err; listSends?: Err & { code?: string } } = {}) {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let head = false;
    let patch: Row | null = null;
    let limit = Infinity;
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, limit);
    const q: any = {
      select: (_c: string, opts?: { head?: boolean }) => { head = !!opts?.head; return q; },
      update: (p: Row) => { patch = p; return q; },
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
      in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; },
      lt: (k: string, v: string) => { filters.push((r) => r[k] < v); return q; },
      limit: (n: number) => { limit = n; return q; },
      single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        let out: unknown;
        if (patch) {
          if (table === 'sends' && fail.updateSends) out = { error: fail.updateSends };
          else { for (const r of rows()) Object.assign(r, patch); out = { error: null }; }
        } else if (head) {
          out = table === 'recips' && fail.countRecipients ? { count: null, error: fail.countRecipients } : { count: rows().length, error: null };
        } else if (table === 'sends' && fail.listSends) out = { data: null, error: fail.listSends };
        else out = { data: rows(), error: null };
        return Promise.resolve(out).then(res, rej);
      },
    };
    return q;
  };
  const warnings: unknown[][] = [];
  const deps = { supabase: { from }, logger: { warn: (...a: unknown[]) => warnings.push(a), info() {}, error() {} }, config: {} } as never;
  return { deps, warnings };
}

const binding = { sendsTable: 'sends', recipientsTable: 'recips' } as never;

describe('finalizeStranded', () => {
  it('closes off a stale sending send with every recipient sent', async () => {
    const sends = [{ id: 's1', status: 'sending', updated_at: OLD, total_recipients: 0, sent_count: 0 }];
    const recips = [{ send_id: 's1', status: 'sent' }, { send_id: 's1', status: 'sent' }, { send_id: 's1', status: 'skipped' }];
    const { deps } = fakeDb({ sends, recips });
    expect(await finalizeStranded(deps, binding, NOW)).toEqual(['s1']);
    expect(sends[0]).toMatchObject({ status: 'sent', sent_count: 2 });
    expect(sends[0].completed_at).toBeTruthy();
  });

  it('leaves a send that still has recipients to send', async () => {
    const sends = [{ id: 's1', status: 'sending', updated_at: OLD, total_recipients: 2 }];
    const recips = [{ send_id: 's1', status: 'sent' }, { send_id: 's1', status: 'pending' }];
    const { deps } = fakeDb({ sends, recips });
    expect(await finalizeStranded(deps, binding, NOW)).toEqual([]);
    expect(sends[0].status).toBe('sending');
  });

  it('leaves a send that moved within the last ten minutes', async () => {
    const sends = [{ id: 's1', status: 'sending', updated_at: FRESH, total_recipients: 1 }];
    const { deps } = fakeDb({ sends, recips: [{ send_id: 's1', status: 'sent' }] });
    expect(await finalizeStranded(deps, binding, NOW)).toEqual([]);
    expect(sends[0].status).toBe('sending');
  });

  it('only looks at sending sends', async () => {
    const sends = [{ id: 's1', status: 'paused', updated_at: OLD, total_recipients: 1 }];
    const { deps } = fakeDb({ sends, recips: [{ send_id: 's1', status: 'sent' }] });
    expect(await finalizeStranded(deps, binding, NOW)).toEqual([]);
    expect(sends[0].status).toBe('paused');
  });

  it('skips a send whose outstanding count could not be read', async () => {
    const sends = [{ id: 's1', status: 'sending', updated_at: OLD, total_recipients: 1, sent_count: 7 }];
    const { deps } = fakeDb({ sends, recips: [{ send_id: 's1', status: 'sent' }] }, { countRecipients: { message: 'PGRST002' } });
    expect(await finalizeStranded(deps, binding, NOW)).toEqual([]);
    expect(sends[0]).toMatchObject({ status: 'sending', sent_count: 7 });
  });

  it('does nothing for a binding whose sends table does not exist on this brand', async () => {
    const { deps } = fakeDb({}, { listSends: { code: 'PGRST205', message: "Could not find the table 'public.plays_sends'" } });
    expect(await finalizeStranded(deps, binding, NOW)).toEqual([]);
  });

  it('still raises any other error listing sends', async () => {
    const { deps } = fakeDb({}, { listSends: { code: 'PGRST002', message: 'schema cache' } });
    await expect(finalizeStranded(deps, binding, NOW)).rejects.toThrow('schema cache');
  });

  it('carries on to the next send when one update fails, and does not report it as finalized', async () => {
    const sends = [{ id: 's1', status: 'sending', updated_at: OLD, total_recipients: 1 }];
    const { deps, warnings } = fakeDb({ sends, recips: [{ send_id: 's1', status: 'sent' }] }, { updateSends: { message: 'PGRST002' } });
    expect(await finalizeStranded(deps, binding, NOW)).toEqual([]);
    expect(sends[0].status).toBe('sending');
    expect(JSON.stringify(warnings)).toContain('PGRST002');
  });
});
