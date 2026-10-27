/**
 * Per-event cache of the Cvent sync ledger, shared by every admin component on
 * the registrations tab (the status bar, the column header and one cell per
 * row). Without it each row would fetch the ledger for itself.
 *
 * Framework-free so it can be unit tested; the React hook in admin/ wraps it.
 */

export interface LedgerRow {
  registration_id: string;
  status: 'synced' | 'failed';
  synced_at: string | null;
  last_error: string | null;
  attempts: number;
}

export interface LedgerStatus {
  active?: number;
  synced?: number;
  pending?: number;
  failed?: number;
  last_synced_at?: string | null;
  last_error?: string | null;
}

/** What GET /events/:eventId/ledger returns. */
export interface LedgerPayload {
  configured: boolean;
  sync_enabled: boolean;
  credentials_configured: boolean;
  status: LedgerStatus;
  rows: LedgerRow[];
  /** True when the server capped `rows`; registrants past the cap cannot be labelled. */
  truncated?: boolean;
}

export interface EventLedger {
  configured: boolean;
  syncEnabled: boolean;
  credentialsConfigured: boolean;
  status: LedgerStatus;
  rows: Map<string, LedgerRow>;
  truncated: boolean;
  fetchedAt: number;
  error: string | null;
}

export interface LedgerCache {
  /** Last known ledger for the event, if any has been loaded. */
  get(eventId: string): EventLedger | undefined;
  /** Load (or return the fresh cached copy). Concurrent calls share one request. */
  load(eventId: string, force?: boolean): Promise<EventLedger>;
  /** Called after every load for the event, including failed ones. */
  subscribe(eventId: string, listener: (ledger: EventLedger) => void): () => void;
  /** Forget the cached copy so the next load fetches again. */
  invalidate(eventId: string): void;
}

export interface LedgerCacheOptions {
  /** A cached copy younger than this is returned without a request. Default 10s. */
  ttlMs?: number;
  now?: () => number;
}

export function createLedgerCache(
  fetcher: (eventId: string) => Promise<LedgerPayload>,
  opts: LedgerCacheOptions = {},
): LedgerCache {
  const ttlMs = opts.ttlMs ?? 10_000;
  const now = opts.now ?? Date.now;
  const ledgers = new Map<string, EventLedger>();
  const inflight = new Map<string, Promise<EventLedger>>();
  const listeners = new Map<string, Set<(ledger: EventLedger) => void>>();

  function emit(eventId: string, ledger: EventLedger) {
    for (const l of listeners.get(eventId) ?? []) {
      try {
        l(ledger);
      } catch {
        // One listener failing must not stop the others.
      }
    }
  }

  function toLedger(payload: LedgerPayload): EventLedger {
    const rows = new Map<string, LedgerRow>();
    for (const r of payload.rows ?? []) rows.set(r.registration_id, r);
    return {
      configured: payload.configured === true,
      syncEnabled: payload.sync_enabled === true,
      credentialsConfigured: payload.credentials_configured === true,
      status: payload.status ?? {},
      rows,
      truncated: payload.truncated === true,
      fetchedAt: now(),
      error: null,
    };
  }

  async function load(eventId: string, force = false): Promise<EventLedger> {
    const cached = ledgers.get(eventId);
    if (!force && cached && cached.error === null && now() - cached.fetchedAt < ttlMs) return cached;
    const running = inflight.get(eventId);
    if (running) return running;

    const p = fetcher(eventId)
      .then((payload) => toLedger(payload))
      .catch((err: unknown) => {
        // Keep the last good rows so cells do not flicker to "unknown" on a
        // transient fetch error; just mark the ledger as stale with the error.
        const prev = ledgers.get(eventId);
        return {
          configured: prev?.configured ?? false,
          syncEnabled: prev?.syncEnabled ?? false,
          credentialsConfigured: prev?.credentialsConfigured ?? false,
          status: prev?.status ?? {},
          rows: prev?.rows ?? new Map<string, LedgerRow>(),
          truncated: prev?.truncated ?? false,
          fetchedAt: now(),
          error: err instanceof Error ? err.message : String(err),
        } satisfies EventLedger;
      })
      .then((ledger) => {
        ledgers.set(eventId, ledger);
        inflight.delete(eventId);
        emit(eventId, ledger);
        return ledger;
      });
    inflight.set(eventId, p);
    return p;
  }

  return {
    get: (eventId) => ledgers.get(eventId),
    load,
    subscribe(eventId, listener) {
      let set = listeners.get(eventId);
      if (!set) {
        set = new Set();
        listeners.set(eventId, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
        if (set && set.size === 0) listeners.delete(eventId);
      };
    },
    invalidate(eventId) {
      ledgers.delete(eventId);
    },
  };
}
