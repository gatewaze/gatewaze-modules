/** Thin hook wrapping supabase.rpc for the geo-engagement RPCs (spec §7). */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { GeoEnvelope, GeoMeta } from './geo-types.js';
import { RPC_SCHEMA_VERSION } from './geo-types.js';

export interface GeoRpcState<T> {
  env: GeoEnvelope<T> | null;
  loading: boolean;
  error: string | null;
  /** True when the RPC contract version differs from the UI's expectation. */
  schemaMismatch: boolean;
}

/**
 * Call a geo RPC. `params` are the p_* args. Re-runs when `deps` change. The
 * RPC returns a single jsonb `{data, meta}` envelope; we surface a clean error
 * string (the RPC raises SQLSTATE 22023 with a readable message on bad input)
 * and flag a schema_version mismatch so the UI can show "report needs update"
 * instead of mis-rendering (spec §9, §11a).
 */
export function useGeoRpc<T>(
  fn: string,
  params: Record<string, unknown>,
  deps: ReadonlyArray<unknown>,
): GeoRpcState<T> {
  const [state, setState] = useState<GeoRpcState<T>>({
    env: null, loading: true, error: null, schemaMismatch: false,
  });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    // supabase.rpc returns a thenable query builder (PromiseLike, no `.catch`),
    // so we await it inside an async IIFE with try/catch.
    void (async () => {
      try {
        const { data, error } = (await supabase.rpc(fn, params)) as {
          data: unknown;
          error: { message: string } | null;
        };
        if (cancelled) return;
        if (error) {
          setState({ env: null, loading: false, error: error.message, schemaMismatch: false });
          return;
        }
        const env = (data ?? { data: [], meta: null }) as GeoEnvelope<T>;
        const meta = env.meta as GeoMeta | null;
        const mismatch = !!meta && meta.schema_version !== RPC_SCHEMA_VERSION;
        setState({ env, loading: false, error: null, schemaMismatch: mismatch });
      } catch (e: unknown) {
        if (cancelled) return;
        setState({
          env: null, loading: false,
          error: e instanceof Error ? e.message : 'Failed to load report',
          schemaMismatch: false,
        });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
