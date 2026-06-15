/**
 * useFeatureFlags — fetches /api/admin/feature-flags once per mount and
 * exposes the canvas kill-switch + env-driven limits to admin UI.
 *
 * Per spec-sites-wysiwyg-builder §6.0 the admin UI must hide the canvas
 * tab when CANVAS_ENABLED=false at the platform. This hook is the
 * single read path; SiteCanvasEditor and any future consumer share it
 * (kept in module-level state so the network call only runs once per
 * page lifetime — flags rarely flip).
 */

import { useEffect, useState } from 'react';

export interface FeatureFlags {
  canvasEnabled: boolean;
  canvasOpBatchMax: number;
  canvasBlockCountMax: number;
  canvasLockTtlSeconds: number;
  /** Per spec-builder-evaluation §3.7. */
  canvasEngineDefault: 'legacy' | 'puck';
}

export interface FeatureFlagsState {
  flags: FeatureFlags | null;
  loading: boolean;
  error: string | null;
}

interface FeatureFlagsResponse {
  canvas_enabled: boolean;
  canvas_op_batch_max: number;
  canvas_block_count_max: number;
  canvas_lock_ttl_seconds: number;
  canvas_engine_default?: 'legacy' | 'puck';
}

let cached: FeatureFlags | null = null;
let inflight: Promise<FeatureFlags> | null = null;

async function fetchFlagsOnce(): Promise<FeatureFlags> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    // Match canvas-service's auth pattern — pull the JWT from the
    // supabase session and attach as Bearer. The platform's
    // requireJwt middleware reads `Authorization`, not cookies; without
    // this the endpoint returns 401 and the fail-open path below
    // defaults canvasEngineDefault to 'legacy', which then mounts the
    // wrong editor across the admin.
    const { supabase } = await import('@/lib/supabase');
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const apiUrl = import.meta.env.VITE_API_URL ?? '';
    const res = await fetch(`${apiUrl}/api/admin/feature-flags`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) {
      throw new Error(`feature-flags fetch failed: ${res.status}`);
    }
    const body = (await res.json()) as FeatureFlagsResponse;
    cached = {
      canvasEnabled: body.canvas_enabled,
      canvasOpBatchMax: body.canvas_op_batch_max,
      canvasBlockCountMax: body.canvas_block_count_max,
      canvasLockTtlSeconds: body.canvas_lock_ttl_seconds,
      canvasEngineDefault: body.canvas_engine_default ?? 'legacy',
    };
    return cached;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function useFeatureFlags(): FeatureFlagsState {
  const [state, setState] = useState<FeatureFlagsState>({
    flags: cached,
    loading: cached === null,
    error: null,
  });

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    fetchFlagsOnce()
      .then((flags) => {
        if (cancelled) return;
        setState({ flags, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // Fail-open: if the platform doesn't expose this endpoint
        // (e.g. older deploy), assume canvas is enabled. The server-
        // side gate still protects the data path.
        setState({
          flags: {
            canvasEnabled: true,
            canvasOpBatchMax: 100,
            canvasBlockCountMax: 200,
            canvasLockTtlSeconds: 90,
            canvasEngineDefault: 'legacy',
          },
          loading: false,
          error: msg,
        });
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}
