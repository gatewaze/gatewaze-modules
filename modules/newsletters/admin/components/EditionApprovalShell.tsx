/**
 * The approver's view of an edition (route newsletters/approve/:id, linked
 * from the approval email). A full-screen layer over the admin: a slim header
 * with the edition, its approval state and the Approve / Ask for changes
 * buttons, and the cut-down editor (canvas + fields) below. There is no link
 * into the rest of the editor; everything behind the layer is made inert so it
 * cannot be reached with the keyboard either.
 *
 * Rules (who may decide, the version check) are enforced by the migration-096
 * functions; this component only explains them.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { CheckBadgeIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { Badge, Button, Modal } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Page } from '@/components/shared/Page';
import { approvalService, type ApprovalStatus } from '../utils/approvalService';

interface Props {
  editionId: string;
  subject: string;
  editionDate: string | null | undefined;
  newsletterName: string | null;
  saving: boolean;
  /** Unsaved edits on screen. */
  dirty: boolean;
  onSave: () => Promise<void>;
  /** Save if needed; true when the server holds what is on screen. */
  ensureSaved: () => Promise<boolean>;
  /** The edition version on screen, sent with the decision. */
  getVersion: () => number;
  notices?: ReactNode;
  children: ReactNode;
}

/**
 * Stops the page behind the layer scrolling. Puck copies the host's <style>
 * tags into the canvas iframe too, but nothing in the iframe carries the
 * marker, so the rule never matches there.
 */
const PAGE_SCROLL_LOCK = 'html:has([data-gw-approval-layer]), body:has([data-gw-approval-layer]) { overflow: hidden !important; }';

/**
 * Make everything except `el` (and its ancestors) inert; returns an undo.
 * Page-level widgets outside the app root (e.g. a feedback button) are also
 * hidden: the layer sits inside the app's stacking context, so it cannot be
 * raised above them. Toasts stay visible.
 */
function inertEverythingBut(el: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  const hidden: Array<[HTMLElement, string]> = [];
  let node: HTMLElement | null = el;
  while (node && node.parentElement && node !== document.body) {
    const parent: HTMLElement = node.parentElement;
    for (const sib of Array.from(parent.children)) {
      if (sib !== node && sib instanceof HTMLElement && !sib.inert && sib.tagName !== 'SCRIPT' && sib.tagName !== 'STYLE') {
        sib.inert = true;
        changed.push(sib);
        if (parent === document.body && !sib.querySelector('[data-sonner-toaster]') && !sib.hasAttribute('data-sonner-toaster')) {
          hidden.push([sib, sib.style.visibility]);
          sib.style.visibility = 'hidden';
        }
      }
    }
    node = parent;
  }
  return () => {
    for (const s of changed) s.inert = false;
    for (const [s, v] of hidden) s.style.visibility = v;
  };
}

export function EditionApprovalShell({
  editionId, subject, editionDate, newsletterName, saving, dirty, onSave, ensureSaved, getVersion, notices, children,
}: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<ApprovalStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState<null | 'approved' | 'changes_requested'>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [note, setNote] = useState('');

  useLayoutEffect(() => {
    const el = layerRef.current;
    if (!el) return undefined;
    // The page behind the layer stops scrolling through PAGE_SCROLL_LOCK, not an
    // inline body style: Puck copies the host <body>'s attributes into the
    // canvas iframe when it mounts, so `body.style.overflow = 'hidden'` would
    // stop the email itself from scrolling.
    return inertEverythingBut(el);
  }, []);

  const load = useCallback(async () => {
    try {
      setStatus(await approvalService.status(editionId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load the approval status');
    } finally {
      setLoading(false);
    }
  }, [editionId]);
  useEffect(() => { void load(); }, [load]);

  const decide = async (decision: 'approved' | 'changes_requested', decisionNote: string | null) => {
    setDeciding(decision);
    try {
      if (!(await ensureSaved())) {
        toast.error('Your edits could not be saved, so nothing was decided. Save, then try again.');
        return;
      }
      const r = await approvalService.decide(editionId, decision, getVersion(), decisionNote);
      toast.success(decision === 'approved'
        ? `Approved.${r.notified ? ` ${r.notified} has been told it can be sent.` : ''}`
        : `Changes requested.${r.notified ? ` ${r.notified} has been told.` : ''}`);
      setChangesOpen(false);
      setNote('');
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not record your decision';
      toast.error(msg, { duration: 10000 });
    } finally {
      setDeciding(null);
    }
  };

  const latest = status?.latest ?? null;
  const pending = latest?.status === 'pending';
  const approvedNow = !!status?.gate.allowed && latest?.status === 'approved';
  const canDecide = !!status?.is_approver && (pending || !!status?.is_super_admin)
    && !(pending && latest?.requested_by === status?.me && !status?.is_super_admin);
  const dateLabel = editionDate ? new Date(`${editionDate}T00:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';

  let stateBadge: ReactNode = null;
  if (status?.required) {
    if (approvedNow) stateBadge = <Badge variant="soft" color="green" size="2">Approved</Badge>;
    else if (pending) stateBadge = <Badge variant="soft" color="amber" size="2">{status.is_approver ? 'Waiting for your approval' : 'Waiting for approval'}</Badge>;
    else if (latest?.status === 'changes_requested') stateBadge = <Badge variant="soft" color="red" size="2">Changes requested</Badge>;
    else if (status.gate.reason_code === 'APPROVAL_STALE') stateBadge = <Badge variant="soft" color="amber" size="2">Changed since approval</Badge>;
    else stateBadge = <Badge variant="soft" color="gray" size="2">Not yet requested</Badge>;
  }

  return (
    <Page title={`Approve: ${subject || 'Newsletter edition'}`}>
      <div
        ref={layerRef}
        data-gw-approval-layer=""
        role="dialog"
        aria-modal="true"
        aria-label="Approve newsletter edition"
        className="fixed inset-0 z-[60] flex flex-col bg-[var(--color-background)]"
      >
        <style>{PAGE_SCROLL_LOCK}</style>
        <header className="flex items-center gap-3 flex-wrap px-5 py-3 border-b border-[var(--gray-a5)] bg-[var(--color-panel-solid)]">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-[var(--gray-10)]">{newsletterName ?? 'Newsletter'}{dateLabel ? ` · ${dateLabel}` : ''}</div>
            <div className="text-base font-semibold text-[var(--gray-12)] truncate max-w-[60vw]">{subject || 'Untitled edition'}</div>
          </div>
          {stateBadge}
          <div className="ml-auto flex items-center gap-2">
            {dirty && (
              <Button variant="outlined" onClick={() => void onSave()} disabled={saving || !!deciding}>
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            )}
            {canDecide && (
              <>
                <Button variant="outlined" onClick={() => setChangesOpen(true)} disabled={!!deciding || saving}>
                  Ask for changes
                </Button>
                <Button variant="solid" onClick={() => void decide('approved', null)} disabled={!!deciding || saving || (approvedNow && !dirty)}>
                  <CheckBadgeIcon className="size-4 mr-1" />
                  {deciding === 'approved' ? 'Approving…' : approvedNow && !dirty ? 'Approved' : dirty ? 'Save and approve' : 'Approve'}
                </Button>
              </>
            )}
          </div>
        </header>

        {notices}

        {!loading && status && (
          <ApprovalExplainer status={status} canDecide={canDecide} />
        )}

        {/* The canvas needs a definite height: Puck's preview grows to the
            email's full height and scrolls inside its own container, which
            only works when every box above it has a fixed size. */}
        <main className="relative flex-1 min-h-0 overflow-hidden">
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center"><LoadingSpinner /></div>
          ) : !status?.required ? (
            <Message title="Approval is not set up for this newsletter">There is nothing to approve here.</Message>
          ) : !status.is_approver ? (
            <Message title="You are not an approver for this newsletter">Ask a super admin to add you as an approver if you should be reviewing it.</Message>
          ) : (
            <div className="absolute inset-0 p-4 overflow-hidden">{children}</div>
          )}
        </main>
      </div>

      <Modal
        isOpen={changesOpen}
        onClose={() => (deciding ? undefined : setChangesOpen(false))}
        title="Ask for changes"
        size="md"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="outlined" onClick={() => setChangesOpen(false)} disabled={!!deciding}>Cancel</Button>
            <Button variant="solid" onClick={() => void decide('changes_requested', note.trim())} disabled={!!deciding || !note.trim()}>
              {deciding === 'changes_requested' ? 'Sending…' : 'Send to the editor'}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-[var(--gray-11)] mb-2">Say what needs to change. The editor gets this by email. Any edits you made are saved first.</p>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          rows={5}
          autoFocus
          className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
        />
      </Modal>
    </Page>
  );
}

function ApprovalExplainer({ status, canDecide }: { status: ApprovalStatus; canDecide: boolean }) {
  const latest = status.latest;
  let text: ReactNode = null;
  let tone: 'amber' | 'gray' | 'green' = 'gray';
  if (!status.is_approver || !status.required) return null;
  if (latest?.status === 'pending') {
    text = <>{latest.requested_by_email ?? 'The editor'} asked for your approval{latest.request_note ? <>: &ldquo;{latest.request_note}&rdquo;</> : '.'} You can edit the text in place or in the panel on the right, then approve.</>;
    if (latest.requested_by === status.me && !status.is_super_admin) {
      tone = 'amber';
      text = <>You requested this approval yourself, so another approver has to approve it.</>;
    }
  } else if (latest?.status === 'approved' && status.gate.allowed) {
    tone = 'green';
    text = <>Approved by {latest.decided_by_email ?? 'an approver'}. The editor can now send it.</>;
  } else if (latest?.status === 'changes_requested') {
    tone = 'amber';
    text = <>Changes were requested{latest.decision_note ? <>: &ldquo;{latest.decision_note}&rdquo;</> : '.'} The editor will ask for approval again when they are done.</>;
  } else if (!canDecide) {
    tone = 'amber';
    text = <>The editor has not asked for approval yet. You can read the edition now and approve it once they ask.</>;
  } else {
    text = <>No approval has been requested yet. As a super admin you can approve it now.</>;
  }
  const cls = tone === 'amber'
    ? 'bg-[var(--amber-a3)] text-[var(--amber-11)] border-[var(--amber-a6)]'
    : tone === 'green'
      ? 'bg-[var(--green-a3)] text-[var(--green-11)] border-[var(--green-a6)]'
      : 'bg-[var(--gray-a2)] text-[var(--gray-11)] border-[var(--gray-a5)]';
  return (
    <div className={`flex items-start gap-2 px-5 py-2 text-sm border-b ${cls}`}>
      {tone === 'amber' && <ExclamationTriangleIcon className="size-4 mt-0.5 shrink-0" />}
      <span>{text}</span>
    </div>
  );
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="max-w-lg mx-auto mt-16 text-center">
      <h2 className="text-lg font-semibold text-[var(--gray-12)]">{title}</h2>
      <p className="text-sm text-[var(--gray-11)] mt-2">{children}</p>
    </div>
  );
}
