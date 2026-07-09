/**
 * Sessions tab — per-visitor session list (Umami's Sessions feature)
 * with an expandable activity timeline per session.
 */
import { useEffect, useState } from 'react';
import { getJson, rangeParams, formatDuration, countryLabel, PANEL, MUTED, STRONG, type RangeKey } from './shared';

interface SessionSummary {
  session_id: string;
  first_seen: string;
  last_seen: string;
  pageviews: number;
  events: number;
  country: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  entry_path: string | null;
  exit_path: string | null;
}
interface SessionEvent { at: string; page_path: string; event_name: string | null; referrer: string | null }

export default function SessionsTab({ propertyId, rangeKey }: { propertyId: string; rangeKey: RangeKey }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [activity, setActivity] = useState<Record<string, SessionEvent[]>>({});
  const pageSize = 20;

  useEffect(() => { setPage(1); }, [rangeKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = rangeParams(rangeKey);
    getJson<{ sessions: SessionSummary[]; total: number }>(
      `/api/modules/analytics/properties/${propertyId}/sessions?${qs}&page=${page}&pageSize=${pageSize}`,
    )
      .then((b) => {
        if (cancelled) return;
        setSessions(b.sessions ?? []);
        setTotal(b.total ?? 0);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [propertyId, rangeKey, page]);

  async function toggle(sessionId: string) {
    if (expanded === sessionId) { setExpanded(null); return; }
    setExpanded(sessionId);
    if (!activity[sessionId]) {
      try {
        const qs = rangeParams(rangeKey);
        const b = await getJson<{ events: SessionEvent[] }>(
          `/api/modules/analytics/properties/${propertyId}/sessions/${sessionId}/activity?${qs}`,
        );
        setActivity((prev) => ({ ...prev, [sessionId]: b.events ?? [] }));
      } catch {
        setActivity((prev) => ({ ...prev, [sessionId]: [] }));
      }
    }
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-[var(--red-6)] bg-[var(--red-2)] text-[var(--red-11)] px-4 py-3 text-sm">
          Failed to load sessions: {error}
        </div>
      )}
      <div className={PANEL}>
        <div className="flex items-baseline justify-between mb-3">
          <h3 className={`font-semibold ${STRONG}`}>Sessions</h3>
          <span className={`text-xs ${MUTED}`}>{total.toLocaleString()} in range</span>
        </div>
        {loading ? (
          <p className={`text-sm ${MUTED} py-6`}>Loading sessions…</p>
        ) : sessions.length === 0 ? (
          <p className={`text-sm ${MUTED} py-6`}>No sessions in this range yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={`text-left text-xs uppercase tracking-wide ${MUTED} border-b border-[var(--gray-6)]`}>
                  <th className="py-2 pr-3 font-medium">Started</th>
                  <th className="py-2 pr-3 font-medium">Duration</th>
                  <th className="py-2 pr-3 font-medium">Views</th>
                  <th className="py-2 pr-3 font-medium">Events</th>
                  <th className="py-2 pr-3 font-medium">Entry → Exit</th>
                  <th className="py-2 pr-3 font-medium">Visitor</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => {
                  const dur = (new Date(s.last_seen).getTime() - new Date(s.first_seen).getTime()) / 1000;
                  return (
                    <SessionRow
                      key={s.session_id}
                      s={s}
                      dur={dur}
                      expanded={expanded === s.session_id}
                      events={activity[s.session_id]}
                      onToggle={() => toggle(s.session_id)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 mt-3 text-sm">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="px-2 py-1 rounded border border-[var(--gray-6)] disabled:opacity-40"
            >←</button>
            <span className={MUTED}>Page {page} of {pages}</span>
            <button
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
              className="px-2 py-1 rounded border border-[var(--gray-6)] disabled:opacity-40"
            >→</button>
          </div>
        )}
      </div>
    </div>
  );
}

function SessionRow({ s, dur, expanded, events, onToggle }: {
  s: SessionSummary;
  dur: number;
  expanded: boolean;
  events?: SessionEvent[];
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="border-b border-[var(--gray-4)] cursor-pointer hover:bg-[var(--gray-3)] transition-colors"
      >
        <td className={`py-2 pr-3 whitespace-nowrap ${STRONG}`}>{new Date(s.first_seen).toLocaleString()}</td>
        <td className={`py-2 pr-3 ${STRONG}`}>{formatDuration(Math.max(0, dur))}</td>
        <td className={`py-2 pr-3 tabular-nums ${STRONG}`}>{s.pageviews}</td>
        <td className={`py-2 pr-3 tabular-nums ${STRONG}`}>{s.events}</td>
        <td className={`py-2 pr-3 font-mono text-xs ${STRONG}`}>
          {s.entry_path ?? '—'}{s.exit_path && s.exit_path !== s.entry_path ? ` → ${s.exit_path}` : ''}
        </td>
        <td className={`py-2 pr-3 text-xs ${MUTED}`}>
          {countryLabel(s.country)} · {s.browser ?? '?'} · {s.os ?? '?'} · {s.device ?? '?'}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-[var(--gray-4)]">
          <td colSpan={6} className="py-3 px-4 bg-[var(--gray-2)]">
            {!events ? (
              <span className={`text-xs ${MUTED}`}>Loading activity…</span>
            ) : events.length === 0 ? (
              <span className={`text-xs ${MUTED}`}>No activity recorded.</span>
            ) : (
              <ol className="space-y-1">
                {events.map((e, i) => (
                  <li key={i} className="flex items-center gap-3 text-xs">
                    <span className={`${MUTED} tabular-nums w-20 shrink-0`}>
                      {new Date(e.at).toLocaleTimeString()}
                    </span>
                    {e.event_name ? (
                      <span className="px-1.5 py-0.5 rounded bg-[var(--accent-4)] text-[var(--accent-11)] font-medium">
                        {e.event_name}
                      </span>
                    ) : (
                      <span className={`px-1.5 py-0.5 rounded bg-[var(--gray-4)] ${MUTED}`}>view</span>
                    )}
                    <span className={`font-mono ${STRONG}`}>{e.page_path}</span>
                  </li>
                ))}
              </ol>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
