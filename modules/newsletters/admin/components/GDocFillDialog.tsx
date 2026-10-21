/**
 * "Fill from Google Doc": paste a Google Doc link (or the HTML of a draft),
 * process it, then choose per block whether to keep the current content or
 * use the doc's. Empty blocks are filled by default; a block that already has
 * content (written by hand or by research) keeps it unless the author picks
 * the doc. Nothing is saved until the author clicks Apply.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { DocumentArrowDownIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { Modal, Button, Badge } from '@/components/ui';
import { gdocFillService } from '../utils/approvalService';
import { planGdocMerge, defaultChoice, type GdocChange, type GdocChoice, type GdocProposal } from '../lib/gdoc-merge';
import type { NewsletterEdition, BlockTemplate } from '../utils';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  edition: NewsletterEdition;
  blockTemplates: BlockTemplate[];
  /** Apply the author's choices. Resolves when the edition is saved. */
  onApply: (changes: GdocChange[], choices: Record<string, GdocChoice>) => Promise<void>;
}

type Phase = 'input' | 'processing' | 'review' | 'applying';

const POLL_MS = 2500;
const POLL_LIMIT_MS = 6 * 60_000;

export function GDocFillDialog({ isOpen, onClose, edition, blockTemplates, onApply }: Props) {
  const [phase, setPhase] = useState<Phase>('input');
  const [mode, setMode] = useState<'doc' | 'html'>('doc');
  const [url, setUrl] = useState('');
  const [html, setHtml] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<GdocProposal | null>(null);
  const [choices, setChoices] = useState<Record<string, GdocChoice>>({});
  const [elapsed, setElapsed] = useState(0);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    cancelled.current = false;
    setPhase('input');
    setError(null);
    setProposal(null);
    setChoices({});
    return () => { cancelled.current = true; };
  }, [isOpen]);

  const changes = useMemo(
    () => (proposal ? planGdocMerge(edition, proposal, blockTemplates) : []),
    [proposal, edition, blockTemplates],
  );

  const process = async () => {
    setError(null);
    setPhase('processing');
    setElapsed(0);
    const started = Date.now();
    try {
      const { job_id } = await gdocFillService.start(edition.id, mode === 'doc' ? { google_doc_url: url.trim() } : { html });
      for (;;) {
        if (cancelled.current) return;
        await new Promise((r) => setTimeout(r, POLL_MS));
        setElapsed(Math.round((Date.now() - started) / 1000));
        const job = await gdocFillService.job(job_id);
        if (job.status === 'complete' && job.proposal) {
          setProposal(job.proposal);
          setChoices({});
          setPhase('review');
          return;
        }
        if (job.status === 'failed') throw new Error(job.error || 'The import failed.');
        if (Date.now() - started > POLL_LIMIT_MS) throw new Error('The import is taking too long. Try again.');
      }
    } catch (e) {
      if (cancelled.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase('input');
    }
  };

  const choiceOf = (c: GdocChange): GdocChoice => choices[c.id] ?? defaultChoice(c);
  const willApply = changes.filter((c) => choiceOf(c) === 'doc').length;

  const apply = async () => {
    setPhase('applying');
    setError(null);
    try {
      await onApply(changes, Object.fromEntries(changes.map((c) => [c.id, choiceOf(c)])));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('review');
    }
  };

  const busy = phase === 'processing' || phase === 'applying';
  const canProcess = mode === 'doc' ? url.trim().length > 0 : html.trim().length > 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={busy ? () => undefined : onClose}
      title="Fill from Google Doc"
      size={phase === 'review' || phase === 'applying' ? 'xl' : 'lg'}
      footer={
        <div className="flex items-center justify-end gap-2">
          {phase === 'review' || phase === 'applying' ? (
            <>
              <Button variant="outlined" onClick={() => setPhase('input')} disabled={busy}>Back</Button>
              <Button variant="solid" onClick={apply} disabled={busy || willApply === 0}>
                {phase === 'applying' ? 'Applying…' : `Apply ${willApply} change${willApply === 1 ? '' : 's'} and save`}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outlined" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant="solid" onClick={process} disabled={busy || !canProcess}>
                {phase === 'processing' ? `Processing… ${elapsed}s` : 'Process'}
              </Button>
            </>
          )}
        </div>
      }
    >
      {(phase === 'input' || phase === 'processing') && (
        <div className="space-y-3">
          <p className="text-sm text-[var(--gray-11)]">
            The draft&apos;s sections are put into this edition&apos;s blocks, using your wording as written.
            You choose what to keep before anything changes.
          </p>
          <div className="flex gap-2 text-sm">
            <button type="button" className={tabCls(mode === 'doc')} onClick={() => setMode('doc')} disabled={busy}>Google Doc link</button>
            <button type="button" className={tabCls(mode === 'html')} onClick={() => setMode('html')} disabled={busy}>Paste HTML</button>
          </div>
          {mode === 'doc' ? (
            <div>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://docs.google.com/document/d/…"
                disabled={busy}
                className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
              />
              <p className="text-xs text-[var(--gray-9)] mt-1">
                The document must be shared as &ldquo;Anyone with the link can view&rdquo;, unless your Google account is connected to Gatewaze.
              </p>
            </div>
          ) : (
            <textarea
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              placeholder="Paste the newsletter HTML here"
              rows={10}
              disabled={busy}
              className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-xs font-mono text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
            />
          )}
          {phase === 'processing' && (
            <p className="text-sm text-[var(--gray-11)]">Reading the document and sorting it into blocks. This usually takes under a minute.</p>
          )}
          {error && <ErrorNote message={error} />}
        </div>
      )}

      {(phase === 'review' || phase === 'applying') && proposal && (
        <div className="space-y-3">
          {changes.length === 0 ? (
            <p className="text-sm text-[var(--gray-11)]">The document did not match any of this edition&apos;s blocks.</p>
          ) : (
            <p className="text-sm text-[var(--gray-11)]">
              Empty blocks are filled from the document. Blocks that already have content keep it unless you choose the document.
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {changes.map((c) => (
              <li key={c.id} className="rounded-lg border border-[var(--gray-a5)] p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm text-[var(--gray-12)]">{c.label}</span>
                  {c.kind === 'new_block' && <Badge variant="soft" color="blue" size="1">New block</Badge>}
                  {c.research && <Badge variant="soft" color="purple" size="1">Research block</Badge>}
                  {c.conflict && <Badge variant="soft" color="amber" size="1">Has content</Badge>}
                  {c.source_heading && <span className="text-xs text-[var(--gray-9)]">from &ldquo;{c.source_heading}&rdquo;</span>}
                  <span className="ml-auto flex gap-1">
                    {c.kind !== 'new_block' && (
                      <button type="button" className={tabCls(choiceOf(c) === 'keep')} disabled={busy} onClick={() => setChoices((s) => ({ ...s, [c.id]: 'keep' }))}>
                        {c.conflict ? 'Keep current' : 'Leave empty'}
                      </button>
                    )}
                    {c.kind === 'new_block' && (
                      <button type="button" className={tabCls(choiceOf(c) === 'keep')} disabled={busy} onClick={() => setChoices((s) => ({ ...s, [c.id]: 'keep' }))}>
                        Skip
                      </button>
                    )}
                    <button type="button" className={tabCls(choiceOf(c) === 'doc')} disabled={busy} onClick={() => setChoices((s) => ({ ...s, [c.id]: 'doc' }))}>
                      {c.kind === 'new_block' ? 'Add block' : 'Use document'}
                    </button>
                  </span>
                </div>
                <div className={`mt-2 grid gap-2 text-xs ${c.conflict ? 'sm:grid-cols-2' : ''}`}>
                  {c.conflict && (
                    <div className={`rounded-md p-2 ${choiceOf(c) === 'keep' ? 'bg-[var(--green-a3)]' : 'bg-[var(--gray-a2)]'}`}>
                      <div className="font-medium text-[var(--gray-11)] mb-0.5">Current</div>
                      <div className="text-[var(--gray-12)]">{c.current_preview || '—'}</div>
                    </div>
                  )}
                  <div className={`rounded-md p-2 ${choiceOf(c) === 'doc' ? 'bg-[var(--green-a3)]' : 'bg-[var(--gray-a2)]'}`}>
                    <div className="font-medium text-[var(--gray-11)] mb-0.5">From the document</div>
                    <div className="text-[var(--gray-12)]">{c.incoming_preview || '—'}</div>
                  </div>
                </div>
                {c.research && choiceOf(c) === 'doc' && (
                  <p className="mt-2 text-xs text-[var(--gray-10)]">
                    The researched items are hidden and the document&apos;s items are shown instead. You can change this later in the block&apos;s Research panel.
                  </p>
                )}
              </li>
            ))}
          </ul>
          {proposal.unmapped.length > 0 && (
            <div className="rounded-lg border border-[var(--orange-a6)] bg-[var(--orange-a2)] p-3 text-sm text-[var(--orange-11)]">
              <div className="font-medium mb-1">Not placed in any block</div>
              <ul className="list-disc pl-5 space-y-0.5">
                {proposal.unmapped.map((u, i) => <li key={i}><strong>{u.heading}</strong>{u.reason ? `: ${u.reason}` : ''}</li>)}
              </ul>
            </div>
          )}
          {error && <ErrorNote message={error} />}
        </div>
      )}
    </Modal>
  );
}

function tabCls(active: boolean): string {
  return `px-2.5 py-1 rounded-md border text-xs ${active
    ? 'border-[var(--accent-8)] bg-[var(--accent-a3)] text-[var(--accent-11)] font-medium'
    : 'border-[var(--gray-a6)] text-[var(--gray-11)] hover:bg-[var(--gray-a3)]'}`;
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="flex gap-2 items-start rounded-md border border-[var(--red-a6)] bg-[var(--red-a2)] p-2.5 text-sm text-[var(--red-11)]">
      <ExclamationTriangleIcon className="size-4 mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

export function GDocFillButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="Fill this edition's blocks from a Google Doc"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 13, fontWeight: 500,
        border: '1px solid var(--gray-a6, #d1d5db)', borderRadius: 8, background: 'var(--color-panel-solid, white)',
        color: 'var(--gray-12, #111)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
      }}
    >
      <DocumentArrowDownIcon className="w-4 h-4" />
      <span>Fill from Google Doc</span>
    </button>
  );
}

