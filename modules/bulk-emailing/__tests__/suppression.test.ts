import { describe, it, expect } from 'vitest';
import { splitSuppressed, suppressionHash, type Recipient } from '../worker/send-engine/engine';

const rec = (id: string, email: string | null): Recipient => ({ id, send_id: 's1', person_id: null, email, timezone: null });

function deps(result: { data?: Array<{ email_sha256: string }>; error?: { code?: string; message?: string } }) {
  const seen: string[][] = [];
  return {
    seen,
    deps: {
      supabase: {
        from: () => ({
          select: () => ({
            in: (_c: string, hashes: string[]) => { seen.push(hashes); return Promise.resolve({ data: result.data ?? [], error: result.error ?? null }); },
          }),
        }),
      },
      logger: console,
      config: {},
    } as never,
  };
}

describe('splitSuppressed', () => {
  it('skips suppressed addresses whatever their case', async () => {
    const { deps: d } = deps({ data: [{ email_sha256: suppressionHash('erased@example.com') }] });
    const out = await splitSuppressed(d, [rec('1', ' Erased@Example.com'), rec('2', 'ok@example.com'), rec('3', null)]);
    expect(out.suppressed.map((r) => r.id)).toEqual(['1']);
    expect(out.allowed.map((r) => r.id)).toEqual(['2', '3']);
  });
  it('sends normally when the compliance module is not installed', async () => {
    const { deps: d } = deps({ error: { code: 'PGRST205', message: 'Could not find the table public.compliance_suppressions in the schema cache' } });
    const out = await splitSuppressed(d, [rec('1', 'a@example.com')]);
    expect(out.error).toBeUndefined();
    expect(out.allowed).toHaveLength(1);
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
