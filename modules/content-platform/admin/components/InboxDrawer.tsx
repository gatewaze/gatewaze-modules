import { useEffect, useState } from 'react';
import { Badge, Button, Card } from '@/components/ui';
import { inboxService, type InboxRow, type ExplainResponse } from '../utils/inboxService';

export function InboxDrawer({
  row,
  onClose,
  onActed,
}: {
  row: InboxRow;
  onClose: () => void;
  onActed: () => void;
}) {
  const [explain, setExplain] = useState<ExplainResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [showReject, setShowReject] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    inboxService.explain(row.triage_item_id)
      .then((d) => { if (mounted) setExplain(d); })
      .catch((err) => { if (mounted) setError(err.message); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [row.triage_item_id]);

  const act = async (action: 'approve' | 'reject' | 'reopen', params: any = {}) => {
    setActing(true);
    setError(null);
    try {
      const r = await inboxService.bulk(action, [{
        triage_item_id: row.triage_item_id,
        lifecycle_key: row.lifecycle_key,
      }], params);
      if (r.failed > 0) {
        const e = r.errors[0];
        setError(`${e.code}: ${e.message}`);
        return;
      }
      onActed();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setActing(false);
    }
  };

  const memberRule = explain?.matched_rules.find((r) => r.metadata?.kind === 'membership');

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex justify-end" onClick={onClose}>
      <div
        className="w-[640px] h-full bg-[var(--color-bg)] shadow-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-start justify-between mb-4 gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Badge variant="soft" color="blue" className="capitalize">{row.content_type}</Badge>
                {row.publish_state && (
                  <Badge variant="soft" color="amber">{row.publish_state.replace(/_/g, ' ')}</Badge>
                )}
                {row.category && (
                  <Badge variant="soft" color={row.category === 'members' ? 'green' : 'gray'}>
                    {row.category}
                  </Badge>
                )}
              </div>
              <h2 className="text-xl font-semibold truncate">
                {row.title ?? <span className="italic text-[var(--gray-10)]">untitled</span>}
              </h2>
              {row.subtitle && (
                <p className="text-sm text-[var(--gray-11)] mt-1">{row.subtitle}</p>
              )}
            </div>
            <button onClick={onClose} className="text-[var(--gray-11)] hover:text-[var(--gray-12)] flex-shrink-0 text-xl">
              ×
            </button>
          </div>

          {row.thumbnail_url && (
            <img src={row.thumbnail_url} alt="" className="w-full h-48 object-cover rounded-lg mb-4" />
          )}

          <div className="flex gap-2 mb-6">
            <Button onClick={() => act('approve')} disabled={acting}>
              {acting ? 'Working…' : 'Approve'}
            </Button>
            <Button variant="soft" color="red" onClick={() => setShowReject((v) => !v)} disabled={acting}>
              Reject
            </Button>
            <Button variant="ghost" onClick={onClose}>Close</Button>
          </div>

          {showReject && (
            <Card className="p-3 mb-4 border border-red-500/30">
              <label className="block text-xs font-medium mb-1">Rejection reason</label>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                rows={2}
                className="w-full px-2 py-1 text-sm border border-[var(--gray-a6)] rounded bg-[var(--color-surface)]"
              />
              <div className="flex gap-2 mt-2">
                <Button
                  size="1"
                  color="red"
                  onClick={() => act('reject', { reason: rejectReason })}
                  disabled={!rejectReason.trim() || acting}
                >
                  Confirm reject
                </Button>
                <Button size="1" variant="ghost" onClick={() => setShowReject(false)}>Cancel</Button>
              </div>
            </Card>
          )}

          {error && (
            <div className="p-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-md text-sm text-red-600">
              {error}
            </div>
          )}

          {loading ? (
            <div className="text-sm text-[var(--gray-11)]">Loading explanation…</div>
          ) : explain && (
            <div className="space-y-4">
              <Card className="p-3">
                <h3 className="text-sm font-semibold mb-2">Why is this here?</h3>
                <ul className="text-xs text-[var(--gray-11)] space-y-1">
                  <li>
                    <strong>Source:</strong> {explain.source?.source_kind ?? 'unknown'}
                    {explain.source?.source_ref && ` · ${explain.source.source_ref}`}
                  </li>
                  {explain.keyword_verdict && (
                    <li>
                      <strong>Keyword verdict:</strong> is_visible={String(explain.keyword_verdict.is_visible)}
                      , {explain.matched_rules.length} matching rule(s)
                    </li>
                  )}
                  {memberRule && (
                    <li>
                      <strong>Tagged 'members'</strong> because matched rule: <code>{memberRule.name}</code>
                      {memberRule.metadata?.tier && ` (tier: ${memberRule.metadata.tier})`}
                    </li>
                  )}
                  {!memberRule && row.category === 'community' && (
                    <li><strong>Category 'community':</strong> no member rule matched.</li>
                  )}
                </ul>
              </Card>

              {explain.matched_rules.length > 0 && (
                <Card className="p-3">
                  <h3 className="text-sm font-semibold mb-2">Matched keyword rules ({explain.matched_rules.length})</h3>
                  <ul className="text-xs space-y-1">
                    {explain.matched_rules.map((r) => (
                      <li key={r.id} className="flex items-center gap-2">
                        <code>{r.name}</code>
                        <span className="text-[var(--gray-10)]">— {r.pattern}</span>
                        {r.metadata?.kind === 'membership' && (
                          <Badge variant="soft" color="green" size="1">member</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              {explain.state_history.length > 0 && (
                <Card className="p-3">
                  <h3 className="text-sm font-semibold mb-2">State history</h3>
                  <ul className="text-xs text-[var(--gray-11)] space-y-1">
                    {explain.state_history.slice(0, 10).map((h, i) => (
                      <li key={i} className="flex items-center gap-2">
                        <span className="text-[var(--gray-10)] tabular-nums">
                          {new Date(h.occurred_at).toLocaleString()}
                        </span>
                        <span>{h.from_state ?? '∅'} → <strong>{h.to_state}</strong></span>
                        <span className="text-[var(--gray-10)]">by {h.actor}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
