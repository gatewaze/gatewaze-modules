import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  isSitesThemeKindsEnabled,
  clearFeatureFlagCache,
  type FlagsSupabaseClient,
} from '../index.js';

function makeClient(opts: {
  value?: string | null;
  error?: { message: string } | null;
  noRow?: boolean;
}): { client: FlagsSupabaseClient; calls: number } {
  let calls = 0;
  const client: FlagsSupabaseClient = {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _val: unknown) {
              return {
                async maybeSingle<T>() {
                  calls++;
                  if (opts.error) return { data: null, error: opts.error };
                  if (opts.noRow) return { data: null, error: null };
                  return { data: { value: opts.value ?? null } as unknown as T, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  return {
    client,
    get calls() { return calls; },
  } as unknown as { client: FlagsSupabaseClient; calls: number };
}

describe('isSitesThemeKindsEnabled', () => {
  beforeEach(() => {
    clearFeatureFlagCache();
  });

  it('returns true when value is the string "true"', async () => {
    const { client } = makeClient({ value: 'true' });
    expect(await isSitesThemeKindsEnabled(client)).toBe(true);
  });

  it('is case-insensitive on the value', async () => {
    const { client } = makeClient({ value: 'TRUE' });
    expect(await isSitesThemeKindsEnabled(client)).toBe(true);
    clearFeatureFlagCache();
    const { client: c2 } = makeClient({ value: 'True' });
    expect(await isSitesThemeKindsEnabled(c2)).toBe(true);
  });

  it('strips surrounding whitespace', async () => {
    const { client } = makeClient({ value: '  true  ' });
    expect(await isSitesThemeKindsEnabled(client)).toBe(true);
  });

  it('returns false for "false" / arbitrary strings / empty', async () => {
    for (const raw of ['false', '0', '', '1', 'yes', 'on', 'enabled']) {
      clearFeatureFlagCache();
      const { client } = makeClient({ value: raw });
      expect(await isSitesThemeKindsEnabled(client)).toBe(false);
    }
  });

  it('returns false when the row is missing (no installation default)', async () => {
    const { client } = makeClient({ noRow: true });
    expect(await isSitesThemeKindsEnabled(client)).toBe(false);
  });

  it('fails closed on database error', async () => {
    const { client } = makeClient({ error: { message: 'connection refused' } });
    expect(await isSitesThemeKindsEnabled(client)).toBe(false);
  });

  it('caches the result for subsequent calls within the TTL', async () => {
    const fetchSpy = vi.fn(async () => ({ data: { value: 'true' }, error: null }));
    const client: FlagsSupabaseClient = {
      from() {
        return {
          select() {
            return {
              eq() {
                return { maybeSingle: fetchSpy as unknown as () => Promise<{ data: { value: string | null } | null; error: { message: string } | null }> };
              },
            };
          },
        };
      },
    };
    expect(await isSitesThemeKindsEnabled(client)).toBe(true);
    expect(await isSitesThemeKindsEnabled(client)).toBe(true);
    expect(await isSitesThemeKindsEnabled(client)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('skipCache forces a re-read', async () => {
    const fetchSpy = vi.fn(async () => ({ data: { value: 'true' }, error: null }));
    const client: FlagsSupabaseClient = {
      from() {
        return {
          select() {
            return {
              eq() {
                return { maybeSingle: fetchSpy as unknown as () => Promise<{ data: { value: string | null } | null; error: { message: string } | null }> };
              },
            };
          },
        };
      },
    };
    await isSitesThemeKindsEnabled(client);
    await isSitesThemeKindsEnabled(client, { skipCache: true });
    await isSitesThemeKindsEnabled(client, { skipCache: true });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('clearFeatureFlagCache forces re-read on next call', async () => {
    const fetchSpy = vi.fn(async () => ({ data: { value: 'true' }, error: null }));
    const client: FlagsSupabaseClient = {
      from() {
        return {
          select() {
            return {
              eq() {
                return { maybeSingle: fetchSpy as unknown as () => Promise<{ data: { value: string | null } | null; error: { message: string } | null }> };
              },
            };
          },
        };
      },
    };
    await isSitesThemeKindsEnabled(client);
    clearFeatureFlagCache();
    await isSitesThemeKindsEnabled(client);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
