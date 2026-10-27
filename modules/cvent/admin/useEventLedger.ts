import { useCallback, useEffect, useState } from 'react';
import { api } from './client';
import { createLedgerCache, type EventLedger, type LedgerPayload } from '../lib/ledger-cache';

/**
 * One ledger fetch per event, shared by the status bar and every row cell on
 * the registrations tab, refreshed every few seconds while any of them is on
 * screen. The sync worker runs every few seconds too, so this is what makes a
 * registration flip from "Pending" to "In Cvent" without a reload.
 */

const REFRESH_MS = 5_000;

const cache = createLedgerCache((eventId) => api<LedgerPayload>(`/events/${eventId}/ledger`), { ttlMs: REFRESH_MS - 500 });

// Refcounted poller per event: the first subscriber starts it, the last stops it.
const pollers = new Map<string, { count: number; timer: ReturnType<typeof setInterval> }>();

function retain(eventId: string) {
  const p = pollers.get(eventId);
  if (p) {
    p.count += 1;
    return;
  }
  const timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    void cache.load(eventId, true);
  }, REFRESH_MS);
  pollers.set(eventId, { count: 1, timer });
}

function release(eventId: string) {
  const p = pollers.get(eventId);
  if (!p) return;
  p.count -= 1;
  if (p.count <= 0) {
    clearInterval(p.timer);
    pollers.delete(eventId);
  }
}

export function useEventLedger(eventId: string): { ledger: EventLedger | undefined; refresh: () => Promise<EventLedger> } {
  const [ledger, setLedger] = useState<EventLedger | undefined>(() => cache.get(eventId));

  useEffect(() => {
    setLedger(cache.get(eventId));
    const off = cache.subscribe(eventId, setLedger);
    retain(eventId);
    void cache.load(eventId);
    return () => {
      off();
      release(eventId);
    };
  }, [eventId]);

  const refresh = useCallback(() => cache.load(eventId, true), [eventId]);
  return { ledger, refresh };
}

/** For actions elsewhere (sync now, retry) that change the ledger. */
export function refreshEventLedger(eventId: string): Promise<EventLedger> {
  return cache.load(eventId, true);
}
