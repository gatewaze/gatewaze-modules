import { useEffect, useState } from 'react';
import { Badge, Button, Card } from '@/components/ui';
import { SideDrawer } from '@/components/shared/SideDrawer';
import { inboxService, type InboxRow, type ExplainResponse } from '../utils/inboxService';

export function InboxDrawer({
  row,
  onClose,
  onActed,
  onPrev,
  onNext,
  position,
}: {
  row: InboxRow;
  onClose: () => void;
  onActed: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  position?: { current: number; total: number };
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

  const act = async (action: 'approve' | 'reject' | 'reopen' | 'set_state', params: any = {}) => {
    setActing(true);
    setError(null);
    try {
      const r = await inboxService.bulk(action as any, [{
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

  // Context-aware action buttons based on the row's current publish_state.
  // Returns the buttons to render and which (if any) needs a reject-reason prompt.
  type ActionConfig = {
    label: string;
    color?: 'green' | 'red' | 'amber' | 'gray' | 'blue';
    variant?: 'solid' | 'soft';
    onClick: () => void;
    requiresReason?: boolean;
  };
  const stateActions: ActionConfig[] = (() => {
    switch (row.publish_state) {
      case 'pending_review':
        return [
          { label: 'Approve', color: 'green', variant: 'solid', onClick: () => act('approve') },
          { label: 'Reject',  color: 'red',   variant: 'soft',  onClick: () => setShowReject(true), requiresReason: true },
        ];
      case 'auto_suppressed':
        return [
          { label: 'Approve & publish', color: 'green', variant: 'solid', onClick: () => act('set_state', { target_state: 'published' }) },
          { label: 'Reject',            color: 'red',   variant: 'soft',  onClick: () => setShowReject(true), requiresReason: true },
        ];
      case 'published':
        return [
          { label: 'Unpublish', color: 'amber', variant: 'soft',  onClick: () => act('set_state', { target_state: 'unpublished' }) },
          { label: 'Reject',    color: 'red',   variant: 'soft',  onClick: () => setShowReject(true), requiresReason: true },
        ];
      case 'unpublished':
        return [
          { label: 'Republish', color: 'green', variant: 'solid', onClick: () => act('set_state', { target_state: 'published' }) },
        ];
      case 'rejected':
        return [
          { label: 'Reopen for review', color: 'blue', variant: 'soft', onClick: () => act('set_state', { target_state: 'pending_review' }) },
        ];
      case 'draft':
        return [
          { label: 'Submit for review', color: 'blue',  variant: 'soft',  onClick: () => act('set_state', { target_state: 'pending_review' }) },
          { label: 'Publish',           color: 'green', variant: 'solid', onClick: () => act('set_state', { target_state: 'published' }) },
        ];
      default:
        return [
          { label: 'Approve', color: 'green', variant: 'solid', onClick: () => act('approve') },
          { label: 'Reject',  color: 'red',   variant: 'soft',  onClick: () => setShowReject(true), requiresReason: true },
        ];
    }
  })();

  const submitReject = () => act('set_state', { target_state: 'rejected', reason: rejectReason });

  const memberRule = explain?.matched_rules.find((r) => r.metadata?.kind === 'membership');

  return (
    <SideDrawer
      open
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
      position={position}
      title={
        <div>
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
      }
    >
      <div className="p-6">
          <div className="flex items-start gap-4 mb-4">
            {row.thumbnail_url && (
              <img
                src={row.thumbnail_url}
                alt=""
                className="w-80 h-auto max-h-80 object-contain rounded-lg bg-[var(--gray-a3)] flex-shrink-0"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            )}
            <div className="flex-1 min-w-0 flex flex-col gap-2">
              {stateActions.map((a, i) => (
                <Button
                  key={i}
                  variant={a.variant ?? 'solid'}
                  color={a.color}
                  onClick={a.onClick}
                  disabled={acting}
                >
                  {acting && i === 0 ? 'Working…' : a.label}
                </Button>
              ))}
              {row.source_url && (
                <a
                  href={row.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium bg-[var(--gray-a3)] hover:bg-[var(--gray-a5)] text-[var(--gray-12)]"
                >
                  View event ↗
                </a>
              )}
            </div>
          </div>

          {row.source_url && (
            <Card className="p-3 mb-4 text-xs text-[var(--gray-11)]">
              <span className="break-all" title={row.source_url}>{row.source_url}</span>
            </Card>
          )}

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
                  onClick={submitReject}
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
                <ul className="text-xs text-[var(--gray-11)] space-y-2">
                  <li>
                    <strong>Source:</strong> {explain.source?.source_kind ?? 'unknown'}
                    {explain.source?.source_ref && ` · ${explain.source.source_ref}`}
                  </li>

                  {/* Member matches — surfaced first since they drive category */}
                  {explain.matched_rules.filter((r) => r.metadata?.kind === 'membership').length > 0 && (
                    <li>
                      <strong>Member match{explain.matched_rules.filter((r) => r.metadata?.kind === 'membership').length > 1 ? 'es' : ''}:</strong>
                      <ul className="mt-1 ml-2 space-y-0.5">
                        {explain.matched_rules
                          .filter((r) => r.metadata?.kind === 'membership')
                          .map((r) => (
                            <li key={r.id} className="flex items-center gap-1.5 flex-wrap">
                              <Badge variant="soft" color="green" size="1">{r.name.replace(/^Member: /, '')}</Badge>
                              {r.metadata?.tier && <span className="text-[var(--gray-10)]">tier: {String(r.metadata.tier)}</span>}
                              <span className="text-[var(--gray-10)]">— matched on <code>{r.pattern}</code></span>
                            </li>
                          ))}
                      </ul>
                    </li>
                  )}

                  {/* Non-member keyword matches */}
                  {explain.matched_rules.filter((r) => r.metadata?.kind !== 'membership').length > 0 && (
                    <li>
                      <strong>Keyword match{explain.matched_rules.filter((r) => r.metadata?.kind !== 'membership').length > 1 ? 'es' : ''}:</strong>
                      <ul className="mt-1 ml-2 space-y-0.5">
                        {explain.matched_rules
                          .filter((r) => r.metadata?.kind !== 'membership')
                          .map((r) => (
                            <li key={r.id} className="flex items-center gap-1.5 flex-wrap">
                              <Badge variant="soft" color="blue" size="1">{r.name}</Badge>
                              <span className="text-[var(--gray-10)]">— matched on <code>{r.pattern}</code></span>
                            </li>
                          ))}
                      </ul>
                    </li>
                  )}

                  {explain.matched_rules.length === 0 && (
                    <li>
                      <strong>No keyword or member rule matched.</strong>{' '}
                      Category defaults to <code>{row.category ?? 'community'}</code>.
                    </li>
                  )}

                  {explain.keyword_verdict && (
                    <li className="text-[var(--gray-10)]">
                      <strong>Verdict:</strong> is_visible={String(explain.keyword_verdict.is_visible)},{' '}
                      evaluated {new Date(explain.keyword_verdict.evaluated_at).toLocaleString()}
                    </li>
                  )}
                </ul>
              </Card>

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
    </SideDrawer>
  );
}
