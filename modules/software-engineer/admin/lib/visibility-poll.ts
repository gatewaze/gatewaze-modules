/**
 * Visibility-aware safety-net polling — pure, React-free, kept in `admin/lib/` so it's
 * unit-testable under the module's node vitest config (no jsdom), mirroring `timeline.ts` and
 * `pr-format.ts`. The component stays a thin view: `useEffect(() => startVisibilityPoll(load,
 * 20000), [load])`.
 *
 * Mirrors the Issues tab's existing pattern (SoftwareEngineerTab.tsx IssuesView): poll on an
 * interval only while the tab is visible, and refetch immediately when it becomes visible again
 * so a backgrounded tab doesn't stay stale. Added as Overview's backstop for a Realtime channel
 * that silently drops — Realtime stays the primary update mechanism; this only guarantees a
 * bound on staleness.
 */

export interface VisibilityPollDoc {
  hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Starts the poll and returns a cleanup function (call from a `useEffect` return). `doc` defaults
 * to the global `document` when present; omitted entirely in a non-DOM environment (SSR/tests),
 * in which case the poll always fires — matching IssuesView's `typeof document === 'undefined'`
 * fallback.
 */
export function startVisibilityPoll(load: () => void, intervalMs: number, doc?: VisibilityPollDoc): () => void {
  const d = doc ?? (typeof document !== 'undefined' ? (document as unknown as VisibilityPollDoc) : undefined);
  const tick = () => { if (!d || !d.hidden) load(); };
  const id = setInterval(tick, intervalMs);
  const onVis = () => { if (!d || !d.hidden) load(); };
  d?.addEventListener('visibilitychange', onVis);
  return () => {
    clearInterval(id);
    d?.removeEventListener('visibilitychange', onVis);
  };
}
