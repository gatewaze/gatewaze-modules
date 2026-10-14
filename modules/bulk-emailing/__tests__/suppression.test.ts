import { describe, it, expect } from 'vitest';
import { beforeEach } from 'vitest';
import { splitSuppressed, suppressionHash, resetSuppressionState, type Recipient } from '../worker/send-engine/engine';

const rec = (id: string, email: string | null): Recipient => ({ id, send_id: 's1', person_id: null, email, timezone: null });

function deps(result: { data?: Array<{ email_sha256: string }>; error?: { code?: string; message?: string }; installed?: boolean | 'error' }) {
  const seen: string[][] = [];
  return {
    seen,
    deps: {
      supabase: {
        from: (table: string) => ({
          select: () => table === 'installed_modules'
            ? { eq: () => ({ maybeSingle: () => Promise.resolve(result.installed === 'error'
                ? { data: null, error: { message: 'boom' } }
                : { data: result.installed ? { id: 'compliance' } : null, error: null }) }) }
            : { in: (_c: string, hashes: string[]) => { seen.push(hashes); return Promise.resolve({ data: result.data ?? [], error: result.error ?? null }); } },
        }),
      },
      logger: console,
      config: {},
    } as never,
  };
}

describe('splitSuppressed', () => {
  beforeEach(() => resetSuppressionState());

  it('skips suppressed addresses whatever their case', async () => {
    const { deps: d } = deps({ data: [{ email_sha256: suppressionHash('erased@example.com') }] });
    const out = await splitSuppressed(d, [rec('1', ' Erased@Example.com'), rec('2', 'ok@example.com'), rec('3', null)]);
    expect(out.suppressed.map((r) => r.id)).toEqual(['1']);
    expect(out.allowed.map((r) => r.id)).toEqual(['2', '3']);
  });
  const missing = { code: 'PGRST205', message: 'Could not find the table public.compliance_suppressions in the schema cache' };
  it('sends normally when the compliance module is not installed', async () => {
    const { deps: d } = deps({ error: missing, installed: false });
    const out = await splitSuppressed(d, [rec('1', 'a@example.com')]);
    expect(out.error).toBeUndefined();
    expect(out.allowed).toHaveLength(1);
  });
  it('holds the batch when the table looks missing but compliance is installed (schema reload)', async () => {
    const { deps: d } = deps({ error: missing, installed: true });
    expect((await splitSuppressed(d, [rec('1', 'a@example.com')])).error).toBeTruthy();
  });
  it('holds the batch when it cannot tell whether compliance is installed', async () => {
    const { deps: d } = deps({ error: missing, installed: 'error' });
    expect((await splitSuppressed(d, [rec('1', 'a@example.com')])).error).toBeTruthy();
  });
  it('never trusts a missing table once it has seen it', async () => {
    await splitSuppressed(deps({}).deps, [rec('1', 'a@example.com')]);
    const { deps: d } = deps({ error: missing, installed: false });
    expect((await splitSuppressed(d, [rec('1', 'a@example.com')])).error).toBeTruthy();
  });
  it('holds the batch on any other failure', async () => {
    const { deps: d } = deps({ error: { code: '57014', message: 'canceling statement due to statement timeout' } });
    const out = await splitSuppressed(d, [rec('1', 'a@example.com')]);
    expect(out.error).toBeTruthy();
    expect(out.allowed).toHaveLength(0);
  });
  it('looks up in chunks of 100', async () => {
    const { deps: d, seen } = deps({});
    await splitSuppressed(d, Array.from({ length: 250 }, (_, i) => rec(String(i), `p${i}@example.com`)));
    expect(seen.map((s) => s.length)).toEqual([100, 100, 50]);
  });
});
