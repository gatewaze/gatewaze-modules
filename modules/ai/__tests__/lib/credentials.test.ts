import { describe, expect, it, beforeEach, vi } from 'vitest';
import { resolveCredential, markCredentialFailed } from '../../lib/credentials.js';
import { NoCredentialsError } from '../../lib/providers/types.js';

/**
 * Hand-rolled supabase stub that records every call and lets each test
 * queue specific responses per (table, op) pair.
 */
function makeStubSupabase() {
  const responseQueueByTable = new Map<string, Array<{ data: unknown; error: unknown }>>();
  const callLog: Array<{ table: string; op: string; args: unknown[] }> = [];

  function queue(table: string, response: { data: unknown; error?: unknown }) {
    const q = responseQueueByTable.get(table) ?? [];
    q.push({ data: response.data, error: response.error ?? null });
    responseQueueByTable.set(table, q);
  }

  function dequeue(table: string) {
    return responseQueueByTable.get(table)?.shift() ?? { data: null, error: null };
  }

  function makeChain(table: string) {
    const chain: Record<string, unknown> = {};
    const record = (op: string) =>
      (...args: unknown[]) => {
        callLog.push({ table, op, args });
        return chain;
      };
    for (const op of ['select', 'eq', 'lte', 'gte', 'in', 'order', 'limit', 'range', 'update', 'insert', 'delete']) {
      chain[op] = record(op);
    }
    chain.maybeSingle = () => {
      callLog.push({ table, op: 'maybeSingle', args: [] });
      return Promise.resolve(dequeue(table));
    };
    chain.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(dequeue(table)).then(onFulfilled, onRejected);
    return chain;
  }

  return {
    client: {
      from(table: string) {
        return makeChain(table);
      },
      rpc(name: string, args: Record<string, unknown>) {
        callLog.push({ table: `rpc:${name}`, op: 'rpc', args: [args] });
        const r = responseQueueByTable.get(`rpc:${name}`)?.shift();
        return Promise.resolve(r ?? { data: null, error: null });
      },
    },
    queue,
    callLog,
  };
}

describe('resolveCredential', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  it('prefers ai_user_credentials when present', async () => {
    const s = makeStubSupabase();
    s.queue('ai_user_credentials', {
      data: {
        id: 'cred-1',
        api_key_ciphertext: new Uint8Array([1, 2, 3]),
        api_key_nonce: new Uint8Array([4, 5, 6]),
        last_4: 'abcd',
      },
    });
    s.queue('rpc:pgsodium_decrypt_text', { data: 'sk-real-user-key' });

    const result = await resolveCredential(s.client as unknown as Parameters<typeof resolveCredential>[0], {
      provider: 'anthropic',
      userId: '11111111-1111-1111-1111-111111111111',
      useCase: 'editor-ai-copilot',
    });
    expect(result.source).toBe('user');
    expect(result.apiKey).toBe('sk-real-user-key');
    expect(result.credentialId).toBe('cred-1');
  });

  it('skips user credentials when systemRunOnly=true', async () => {
    const s = makeStubSupabase();
    // No user creds dequeue should happen at all; queue use_case instead.
    s.queue('ai_use_case_credentials', {
      data: {
        id: 'cred-uc',
        api_key_ciphertext: new Uint8Array([1, 2, 3]),
        api_key_nonce: new Uint8Array([4, 5, 6]),
        last_4: 'wxyz',
      },
    });
    s.queue('rpc:pgsodium_decrypt_text', { data: 'sk-cron-key' });

    const result = await resolveCredential(s.client as unknown as Parameters<typeof resolveCredential>[0], {
      provider: 'anthropic',
      userId: '11111111-1111-1111-1111-111111111111',
      useCase: 'daily-briefing-research',
      systemRunOnly: true,
    });
    expect(result.source).toBe('use_case');
    expect(result.apiKey).toBe('sk-cron-key');
    // Confirm ai_user_credentials was NEVER touched.
    const userCallCount = s.callLog.filter((c) => c.table === 'ai_user_credentials').length;
    expect(userCallCount).toBe(0);
  });

  it('falls back to env variable when no rows present', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env-key-1234';
    const s = makeStubSupabase();
    // Both lookups return null.
    s.queue('ai_user_credentials', { data: null });
    s.queue('ai_use_case_credentials', { data: null });

    const result = await resolveCredential(s.client as unknown as Parameters<typeof resolveCredential>[0], {
      provider: 'anthropic',
      userId: '11111111-1111-1111-1111-111111111111',
      useCase: 'editor-ai-copilot',
    });
    expect(result.source).toBe('env');
    expect(result.apiKey).toBe('sk-env-key-1234');
    expect(result.last4).toBe('1234');
    expect(result.credentialId).toBeNull();
  });

  it('honours GOOGLE_API_KEY as an alias for GEMINI_API_KEY', async () => {
    process.env.GOOGLE_API_KEY = 'AIza-google-fallback';
    const s = makeStubSupabase();
    s.queue('ai_user_credentials', { data: null });
    s.queue('ai_use_case_credentials', { data: null });

    const result = await resolveCredential(s.client as unknown as Parameters<typeof resolveCredential>[0], {
      provider: 'gemini',
      userId: null,
      useCase: 'daily-briefing-cover',
    });
    expect(result.source).toBe('env');
    expect(result.apiKey).toBe('AIza-google-fallback');
  });

  it('throws NoCredentialsError when nothing resolves', async () => {
    const s = makeStubSupabase();
    s.queue('ai_user_credentials', { data: null });
    s.queue('ai_use_case_credentials', { data: null });

    await expect(
      resolveCredential(s.client as unknown as Parameters<typeof resolveCredential>[0], {
        provider: 'anthropic',
        userId: null,
        useCase: 'editor-ai-copilot',
      }),
    ).rejects.toThrow(NoCredentialsError);
  });

  it('does not query user credentials when userId is null', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-system-default';
    const s = makeStubSupabase();
    s.queue('ai_use_case_credentials', { data: null });

    const result = await resolveCredential(s.client as unknown as Parameters<typeof resolveCredential>[0], {
      provider: 'anthropic',
      userId: null,                     // cron run
      useCase: 'daily-briefing-research',
    });
    expect(result.source).toBe('env');
    const userCallCount = s.callLog.filter((c) => c.table === 'ai_user_credentials').length;
    expect(userCallCount).toBe(0);
  });
});

describe('markCredentialFailed', () => {
  it('flips status to disabled after 3 failures', async () => {
    const s = makeStubSupabase();
    s.queue('ai_user_credentials', { data: { failure_count: 2 } });

    const updateSpy = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) });
    const client = {
      from() {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { failure_count: 2 }, error: null }),
            }),
          }),
          update: updateSpy,
        };
      },
    };

    await markCredentialFailed(
      client as unknown as Parameters<typeof markCredentialFailed>[0],
      'ai_user_credentials',
      'cred-1',
      'provider_401',
    );

    expect(updateSpy).toHaveBeenCalledWith({
      failure_count: 3,
      status: 'disabled',
      status_reason: 'provider_401',
    });
  });

  it('keeps status active on first failure', async () => {
    const updateSpy = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) });
    const client = {
      from() {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { failure_count: 0 }, error: null }),
            }),
          }),
          update: updateSpy,
        };
      },
    };

    await markCredentialFailed(
      client as unknown as Parameters<typeof markCredentialFailed>[0],
      'ai_user_credentials',
      'cred-1',
      'provider_401',
    );

    expect(updateSpy).toHaveBeenCalledWith({
      failure_count: 1,
      status: 'active',
      status_reason: null,
    });
  });
});
