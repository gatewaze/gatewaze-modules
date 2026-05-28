import { useEffect, useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { Badge, Button, Card } from '@/components/ui';
import { TriageItem, TriageEvent, TriageService } from '../utils/triageService';

interface Props {
  itemId: string;
  onClose: () => void;
  onActioned: (id: string) => void;
}

type ActionType = 'approve' | 'reject' | 'request-changes' | null;

const inputClass =
  'w-full px-3 py-1.5 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]';

export function TriageDrawer({ itemId, onClose, onActioned }: Props) {
  const [item, setItem] = useState<TriageItem | null>(null);
  const [events, setEvents] = useState<TriageEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<ActionType>(null);
  const [categories, setCategories] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    TriageService.get(itemId)
      .then((res) => {
        if (cancelled) return;
        setItem(res.item);
        setEvents(res.events);
        setCategories(res.item.suggested_categories.join(', '));
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [itemId]);

  async function doApprove() {
    if (!item) return;
    setSubmitting(true); setError(null);
    try {
      await TriageService.approve(item.id, {
        expectedUpdatedAt: item.updated_at,
        appliedCategories: categories.split(',').map((c) => c.trim()).filter(Boolean),
        notes: notes || null,
      });
      onActioned(item.id);
    } catch (e: any) { setError(e.message); }
    finally { setSubmitting(false); }
  }

  async function doReject() {
    if (!item) return;
    if (!reason.trim()) { setError('Reason required'); return; }
    setSubmitting(true); setError(null);
    try {
      await TriageService.reject(item.id, { expectedUpdatedAt: item.updated_at, reason });
      onActioned(item.id);
    } catch (e: any) { setError(e.message); }
    finally { setSubmitting(false); }
  }

  async function doRequestChanges() {
    if (!item) return;
    if (!notes.trim()) { setError('Notes required'); return; }
    setSubmitting(true); setError(null);
    try {
      await TriageService.requestChanges(item.id, { expectedUpdatedAt: item.updated_at, notes });
      onActioned(item.id);
    } catch (e: any) { setError(e.message); }
    finally { setSubmitting(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} />
      <div className="w-full max-w-2xl bg-[var(--color-background)] shadow-xl overflow-y-auto p-6 border-l border-[var(--gray-a6)]">
        {loading || !item ? (
          <div className="text-[var(--gray-10)]">Loading…</div>
        ) : (
          <>
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="text-xs text-[var(--gray-10)] uppercase">{item.content_type}</div>
                <h2 className="text-xl font-semibold text-[var(--gray-12)]">Review item</h2>
                <div className="text-xs text-[var(--gray-10)] mt-1">
                  {item.source}{item.source_ref ? ` · ${item.source_ref}` : ''} · priority {item.priority}
                </div>
              </div>
              <button onClick={onClose} className="p-1 text-[var(--gray-10)] hover:text-[var(--gray-12)]">
                <XMarkIcon className="size-5" />
              </button>
            </div>

            {error && (
              <div className="p-3 mb-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            )}

            <Card variant="surface" className="p-4 mb-4">
              <div className="text-xs text-[var(--gray-10)] uppercase mb-1">Content reference</div>
              <div className="font-mono text-xs">{item.content_id}</div>
              <div className="mt-3 text-xs text-[var(--gray-10)] uppercase mb-1">Suggested categories</div>
              <div className="flex flex-wrap gap-1">
                {item.suggested_categories.length
                  ? item.suggested_categories.map((c) => <Badge key={c} variant="soft">{c}</Badge>)
                  : <span className="text-[var(--gray-9)] text-sm">none</span>}
                <span className="text-xs text-[var(--gray-10)] ml-2">({item.suggested_from})</span>
              </div>
            </Card>

            {item.status === 'pending' && !action && (
              <div className="flex gap-2 mb-4">
                <Button variant="solid" onClick={() => setAction('approve')}>Approve</Button>
                <Button variant="outline" onClick={() => setAction('request-changes')}>Request changes</Button>
                <Button variant="outline" color="red" onClick={() => setAction('reject')}>Reject</Button>
              </div>
            )}

            {action === 'approve' && (
              <Card variant="surface" className="p-4 mb-4">
                <label className="block text-sm font-medium mb-1">Applied categories (comma-separated)</label>
                <input className={inputClass} value={categories} onChange={(e) => setCategories(e.target.value)} />
                <label className="block text-sm font-medium mt-3 mb-1">Notes (optional)</label>
                <textarea className={inputClass} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
                <div className="flex gap-2 mt-3">
                  <Button variant="solid" onClick={doApprove} disabled={submitting}>{submitting ? 'Approving…' : 'Confirm approve'}</Button>
                  <Button variant="outline" onClick={() => setAction(null)}>Cancel</Button>
                </div>
              </Card>
            )}

            {action === 'reject' && (
              <Card variant="surface" className="p-4 mb-4">
                <label className="block text-sm font-medium mb-1">Reason *</label>
                <textarea className={inputClass} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
                <div className="flex gap-2 mt-3">
                  <Button variant="solid" color="red" onClick={doReject} disabled={submitting}>{submitting ? 'Rejecting…' : 'Confirm reject'}</Button>
                  <Button variant="outline" onClick={() => setAction(null)}>Cancel</Button>
                </div>
              </Card>
            )}

            {action === 'request-changes' && (
              <Card variant="surface" className="p-4 mb-4">
                <label className="block text-sm font-medium mb-1">What needs to change? *</label>
                <textarea className={inputClass} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
                <div className="flex gap-2 mt-3">
                  <Button variant="solid" onClick={doRequestChanges} disabled={submitting}>{submitting ? 'Saving…' : 'Request changes'}</Button>
                  <Button variant="outline" onClick={() => setAction(null)}>Cancel</Button>
                </div>
              </Card>
            )}

            {item.status !== 'pending' && (
              <Card variant="surface" className="p-4 mb-4">
                <div className="text-sm">
                  <strong>Status:</strong> {item.status}
                  {item.auto_approved_at && <> · <em>auto-approved</em> {item.auto_approved_reason ? `(${item.auto_approved_reason})` : ''}</>}
                </div>
                {item.review_notes && <div className="text-sm mt-2"><strong>Notes:</strong> {item.review_notes}</div>}
                {item.reject_reason && <div className="text-sm mt-2"><strong>Reason:</strong> {item.reject_reason}</div>}
              </Card>
            )}

            <Card variant="surface" className="p-4">
              <div className="text-xs text-[var(--gray-10)] uppercase mb-2">Recent activity</div>
              {events.length === 0 ? (
                <div className="text-sm text-[var(--gray-9)]">No events.</div>
              ) : (
                <ul className="space-y-2">
                  {events.slice(0, 10).map((e) => (
                    <li key={e.id} className="text-xs">
                      <span className="text-[var(--gray-10)]">{new Date(e.created_at).toLocaleString()}</span>{' '}
                      <strong>{e.event_type}</strong>
                      {e.from_status && e.to_status && <> ({e.from_status} → {e.to_status})</>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
