/**
 * Approval status for one edition, on the Sending tab. Shown only when the
 * newsletter has approvers (migration 096). The editor requests approval
 * here; an approver gets a link to the approval view. Sending stays locked
 * by the send gate until the current content is approved.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { CheckBadgeIcon, ClockIcon, ExclamationTriangleIcon, PaperAirplaneIcon } from '@heroicons/react/24/outline';
import { Badge, Button } from '@/components/ui';
import { approvalService, type ApprovalStatus } from '../utils/approvalService';

interface Props {
  editionId: string;
  /** Called after a request so the Sending tab re-checks the send gate. */
  onChanged?: () => void;
  /** Save the edition first, so the request covers what the editor sees. */
  beforeRequest?: () => Promise<void>;
}

function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '';
}

export function ApprovalPanel({ editionId, onChanged, beforeRequest }: Props) {
  const [status, setStatus] = useState<ApprovalStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!editionId || editionId === 'new') { setStatus(null); setLoading(false); return; }
    try {
      setStatus(await approvalService.status(editionId));
    } catch (e) {
      console.warn('[newsletter-approval] status failed:', e);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [editionId]);
  useEffect(() => { void load(); }, [load]);

  if (loading || !status || !status.required) return null;

  const latest = status.latest;
  const reason = status.gate.reason_code;
  const approved = status.gate.allowed;
  const pending = latest?.status === 'pending';
  const approverNames = status.approvers.map((a) => a.name || a.email).filter(Boolean).join(', ');

  const request = async () => {
    setBusy(true);
    try {
      await beforeRequest?.();
      const r = await approvalService.request(editionId, note.trim() || null);
      setNote('');
      if (r.email_skipped === 'admin_url_not_configured') toast.warning('Approval requested, but no email was sent because this instance has no ADMIN_URL set. Tell the approver to open the edition’s approval view.', { duration: 10000 });
      else if (r.local_only) toast.success(`Approval requested. This is a local admin, so no email was sent; ${r.notified.join(', ') || 'the approver'} can open the approval view from this tab.`);
      else if (r.failed.length > 0) toast.warning(`Approval requested, but the email to ${r.failed.join(', ')} could not be sent. Let them know directly.`);
      else toast.success(r.notified.length ? `Approval requested. Emailed ${r.notified.join(', ')}.` : 'Approval requested.');
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not request approval');
    } finally {
      setBusy(false);
    }
  };

  let tone: 'green' | 'amber' | 'red' | 'gray' = 'gray';
  let headline = 'Approval needed before sending';
  let Icon = ClockIcon;
  if (approved) { tone = 'green'; headline = 'Approved'; Icon = CheckBadgeIcon; }
  else if (reason === 'APPROVAL_PENDING') { tone = 'amber'; headline = 'Waiting for approval'; }
  else if (reason === 'APPROVAL_CHANGES_REQUESTED') { tone = 'red'; headline = 'Changes requested'; Icon = ExclamationTriangleIcon; }
  else if (reason === 'APPROVAL_STALE') { tone = 'amber'; headline = 'Changed since it was approved'; Icon = ExclamationTriangleIcon; }

  const canRequest = !approved || latest?.content_changed_since;

  return (
    <div className="mb-4 rounded-lg border border-[var(--gray-a5)] bg-[var(--color-panel-solid)] p-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Icon className={`size-5 text-[var(--${tone}-11)]`} />
        <span className="font-medium text-[var(--gray-12)]">{headline}</span>
        <Badge variant="soft" color={tone} size="1">Approval</Badge>
        <span className="text-xs text-[var(--gray-10)] ml-auto">Approver{status.approvers.length === 1 ? '' : 's'}: {approverNames || 'none'}</span>
      </div>

      <div className="mt-2 space-y-1 text-sm text-[var(--gray-11)]">
        {latest?.requested_at && (
          <p>Requested by {latest.requested_by_email ?? 'someone'} on {when(latest.requested_at)}.{latest.request_note ? ` “${latest.request_note}”` : ''}</p>
        )}
        {latest?.decided_at && latest.status !== 'pending' && (
          <p>
            {latest.status === 'approved' ? 'Approved' : 'Changes requested'} by {latest.decided_by_email ?? 'an approver'} on {when(latest.decided_at)}.
            {latest.decision_note ? ` “${latest.decision_note}”` : ''}
          </p>
        )}
        {pending && latest?.content_changed_since && (
          <p className="text-[var(--amber-11)]">The content has changed since approval was requested. The approver will see the latest version.</p>
        )}
        {reason === 'APPROVAL_STALE' && (
          <p className="text-[var(--amber-11)]">The content changed after it was approved, so it needs approving again before it can be sent.</p>
        )}
        {approved && <p>This edition can be sent. Any further edit to its content will need approving again.</p>}
      </div>

      {canRequest && (
        <div className="mt-3 flex flex-col gap-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={2}
            placeholder="Note for the approver (optional)"
            className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
          />
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="solid" onClick={request} disabled={busy}>
              <PaperAirplaneIcon className="size-4 mr-1" />
              {busy ? 'Sending request…' : pending ? 'Send the request again' : 'Request approval'}
            </Button>
            {status.is_approver && (
              <Link to={`/newsletters/approve/${editionId}`} className="text-sm text-[var(--accent-11)] hover:underline">
                Open the approval view
              </Link>
            )}
          </div>
        </div>
      )}
      {!canRequest && status.is_approver && (
        <div className="mt-3">
          <Link to={`/newsletters/approve/${editionId}`} className="text-sm text-[var(--accent-11)] hover:underline">Open the approval view</Link>
        </div>
      )}
    </div>
  );
}
