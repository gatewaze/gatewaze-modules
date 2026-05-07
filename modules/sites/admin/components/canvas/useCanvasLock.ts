/**
 * Acquires + heartbeats the canvas lock for a page. Per
 * spec-sites-wysiwyg-builder §6.3.
 *
 * Lifecycle:
 *   - On mount: generates a clientToken (uuid), POSTs /lock to acquire.
 *   - Every 30s: re-POSTs /lock as a heartbeat (idempotent on
 *     (page_id, editor_id, clientToken)).
 *   - On unmount / page change: POSTs /unlock (best-effort).
 *
 * Returns the lock state for the canvas to gate edits on.
 */

import { useEffect, useRef, useState } from 'react';
import { CanvasService } from './canvas-service.js';

export type LockState =
  | { kind: 'idle' }
  | { kind: 'acquiring' }
  | { kind: 'held'; clientToken: string; expiresAt: string; stolenFromTab?: string }
  | { kind: 'conflict'; activeEditor: { id: string }; lockedAt: string }
  | { kind: 'error'; message: string };

const HEARTBEAT_MS = 30_000;

function makeClientToken(): string {
  // 32 hex chars, fits the 16..64 server constraint.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '');
  }
  // Fallback for older environments.
  let t = '';
  for (let i = 0; i < 32; i++) t += Math.floor(Math.random() * 16).toString(16);
  return t;
}

export function useCanvasLock(pageId: string | null): LockState {
  const [state, setState] = useState<LockState>({ kind: 'idle' });
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pageId) {
      setState({ kind: 'idle' });
      return;
    }

    let cancelled = false;
    const token = makeClientToken();
    tokenRef.current = token;
    setState({ kind: 'acquiring' });

    const acquire = async () => {
      const r = await CanvasService.acquireLock(pageId, token);
      if (cancelled) return;
      if (r.ok) {
        setState({
          kind: 'held',
          clientToken: token,
          expiresAt: r.expiresAt,
          ...(r.stolenFromTab ? { stolenFromTab: r.stolenFromTab } : {}),
        });
      } else if (r.error.code === 'canvas.lock_conflict') {
        const detail = r.error.details as { activeEditor?: { id: string }; lockedAt?: string } | undefined;
        setState({
          kind: 'conflict',
          activeEditor: detail?.activeEditor ?? { id: 'unknown' },
          lockedAt: detail?.lockedAt ?? new Date().toISOString(),
        });
      } else {
        setState({ kind: 'error', message: r.error.message });
      }
    };

    void acquire();

    const heartbeat = window.setInterval(() => {
      void acquire();
    }, HEARTBEAT_MS);

    return () => {
      cancelled = true;
      window.clearInterval(heartbeat);
      void CanvasService.releaseLock(pageId, token);
    };
  }, [pageId]);

  return state;
}
