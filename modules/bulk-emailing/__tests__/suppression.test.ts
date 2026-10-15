import { describe, it, expect, beforeEach } from 'vitest';
import { splitSuppressed, resetSuppressionState, type Recipient } from '../worker/send-engine/engine';

const rec = (id: string, email: string | null): Recipient => ({ id, send_id: 's1', person_id: null, email, timezone: null });

function deps(result: { data?: string[]; error?: { code?: string; message?: string }; installed?: boolean | 'error' }) {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      supabase: {
        rpc: (_fn: string, args: { p_emails: string[] }) => {
          calls.push(args.p_emails);
          return Promise.resolve({ data: result.error ? null : (result.data ?? []), error: result.error ?? null });
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve(result.installed === 'error'
                ? { data: null, error: { message: 'boom' } }
                : { data: result.installed ? { id: 'compliance' } : null, error: null }),
            }),
          }),
        }),
      },
      logger: console,
      config: {},
    } as never,
  };
}

const missing = { code: 'PGRST202', message: 'Could not find the function public.compliance_suppressed_emails in the schema cache' };

describe('splitSuppressed', () => {
  beforeEach(() => resetSuppressionState());

  it('skips suppressed addresses whatever their case', async () => {
    const { deps: d, calls } = deps({ data: ['erased@example.com'] });
    const out = await splitSuppressed(d, [rec('1', ' Erased@Example.com'), rec('2', 'ok@example.com'), rec('3', null)]);
    expect(out.suppressed.map((r) => r.id)).toEqual(['1']);
    expect(out.allowed.map((r) => r.id)).toEqual(['2', '3']);
    expect(calls[0]).toEqual(['erased@example.com', 'ok@example.com']);
  });
  it('sends normally when the compliance module is not installed', async () => {
    const { deps: d } = deps({ error: missing, installed: false });
    const out = await splitSuppressed(d, [rec('1', 'a@example.com')]);
    expect(out.error).toBeUndefined();
    expect(out.allowed).toHaveLength(1);
  });
  it('holds the batch when the function looks missing but compliance is installed (schema reload)', async () => {
    const { deps: d } = deps({ error: missing, installed: true });
    expect((await splitSuppressed(d, [rec('1', 'a@example.com')])).error).toBeTruthy();
  });
  it('holds the batch when it cannot tell whether compliance is installed', async () => {
    const { deps: d } = deps({ error: missing, installed: 'error' });
    expect((await splitSuppressed(d, [rec('1', 'a@example.com')])).error).toBeTruthy();
  });
  it('never trusts a missing function once it has seen it', async () => {
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
  it('looks up in chunks of 200', async () => {
    const { deps: d, calls } = deps({});
    await splitSuppressed(d, Array.from({ length: 450 }, (_, i) => rec(String(i), `p${i}@example.com`)));
    expect(calls.map((c) => c.length)).toEqual([200, 200, 50]);
  });
});
