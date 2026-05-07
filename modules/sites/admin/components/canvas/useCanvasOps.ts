/**
 * Op-batching + dispatch hook. Per spec-sites-wysiwyg-builder §5.2 + §5.3.
 *
 * Maintains:
 *   - currentVersion (used as `baseVersion` on the next envelope)
 *   - currentHtml + etag (the iframe srcdoc)
 *   - in-flight applyOps state
 *
 * Submits each op as its own envelope for v1. Phase 2 will add coalescing
 * (debounced batches of inline-edit ops) and an undo/redo stack.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CanvasService } from './canvas-service.js';
import type { CanvasOp, OpEnvelope } from '../../../lib/canvas-render/types.js';

export interface CanvasOpsState {
  loading: boolean;
  /** HTML for the iframe srcdoc; null until first load. */
  html: string | null;
  /** ETag from the last successful render fetch (used for 304s). */
  etag: string | null;
  /** Current pages.version. Used as baseVersion for the next envelope. */
  version: number | null;
  /** Submission state of the most recent envelope. */
  submitting: boolean;
  lastError: string | null;
  /** Set when the server reports version_conflict — prompts a hard reload. */
  versionConflict: boolean;
}

function makeIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Fallback uuid-v4-shape.
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
  return `${s.slice(0,8)}-${s.slice(8,12)}-4${s.slice(13,16)}-${s.slice(16,20)}-${s.slice(20,32)}`;
}

export function useCanvasOps(
  pageId: string | null,
  clientToken: string | null,
  initialVersion: number | null,
) {
  const [state, setState] = useState<CanvasOpsState>({
    loading: false,
    html: null,
    etag: null,
    version: initialVersion,
    submitting: false,
    lastError: null,
    versionConflict: false,
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  // Initial load + reload after page change.
  useEffect(() => {
    if (!pageId) {
      setState((s) => ({ ...s, html: null, etag: null, version: null }));
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, lastError: null }));
    void CanvasService.render(pageId, null).then((r) => {
      if (cancelled) return;
      if (r.ok === true) {
        setState((s) => ({ ...s, loading: false, html: r.html, etag: r.etag }));
      } else if (r.ok === 'not-modified') {
        setState((s) => ({ ...s, loading: false }));
      } else {
        setState((s) => ({ ...s, loading: false, lastError: r.error.message }));
      }
    });
    return () => { cancelled = true; };
  }, [pageId]);

  const submit = useCallback(async (ops: ReadonlyArray<CanvasOp>) => {
    if (!pageId || !clientToken) return;
    if (state.submitting) return;
    if (state.version === null) return;

    const envelope: OpEnvelope = {
      ops,
      baseVersion: state.version,
      clientToken,
      idempotencyKey: makeIdempotencyKey(),
    };

    setState((s) => ({ ...s, submitting: true, lastError: null }));
    const r = await CanvasService.applyOps(pageId, envelope);
    if (r.ok) {
      setState((s) => ({
        ...s,
        submitting: false,
        version: r.response.newVersion,
        html: r.response.render.html,
        etag: r.response.render.contentHash,
      }));
    } else {
      const isConflict = r.error.code === 'canvas.version_conflict';
      setState((s) => ({
        ...s,
        submitting: false,
        lastError: r.error.message,
        versionConflict: isConflict,
      }));
    }
  }, [pageId, clientToken, state.submitting, state.version]);

  // Sync if initialVersion changes (e.g. parent re-fetched the page row).
  useEffect(() => {
    if (initialVersion !== null && state.version === null) {
      setState((s) => ({ ...s, version: initialVersion }));
    }
  }, [initialVersion, state.version]);

  return { state, submit };
}
