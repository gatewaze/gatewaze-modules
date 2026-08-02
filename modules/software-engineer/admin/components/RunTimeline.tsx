// @ts-nocheck
/**
 * RunTimeline — the interactive "watch the agent" view (spec §14.1).
 *
 * Renders the unified, chronological run stream produced by `buildTimeline`
 * (se_events + se_messages) as a sequence of visual steps, giving the flat
 * "Tool activity" dump a VS-Code-like feel:
 *
 *   - a live activity ticker (spinner + "⟳ Editing SPEC.md…") while the run is
 *     live, so you can see what the agent is doing *right now*;
 *   - a one-shot green flash on each newly-arrived step and just-passed phase
 *     pill, so incremental progress is obvious;
 *   - per-step "Show more/less" clamps so verbose assistant prose and tool
 *     output stay minimized until you want them;
 *   - document cards for file writes/edits that expand in place — `.md` files
 *     get a rendered Markdown preview (Raw ↔ Preview toggle), edits get a diff.
 *
 * All motion is scoped to this component's own class names via an injected
 * <style> block (no host Tailwind/global CSS edit) and is disabled under
 * `prefers-reduced-motion`. Design system: Tailwind + Radix gray vars only —
 * no `@radix-ui/themes` import (see CLAUDE.md).
 */
import React, { useEffect, useRef, useState } from 'react';
import { DocumentTextIcon, PencilSquareIcon, ArrowPathIcon, WrenchIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import TranscriptMarkdown from './TranscriptMarkdown';
import { buildTimeline, currentActivity, basename, type TimelineStep, type DocEdit } from '../lib/timeline';

const FLASH_STYLE = `
@keyframes se-flash-in { 0% { background-color: var(--green-4); } 100% { background-color: transparent; } }
@keyframes se-flash-pill { 0% { box-shadow: 0 0 0 2px var(--green-7); } 100% { box-shadow: 0 0 0 0 transparent; } }
.se-flash { animation: se-flash-in 1.1s ease-out; }
.se-flash-pill { animation: se-flash-pill 1.1s ease-out; }
@media (prefers-reduced-motion: reduce) {
  .se-flash, .se-flash-pill { animation: none; }
  .se-spin { animation: none; }
}
`;

/** Collapse-with-Show-more for long text. Renders nothing extra when short. */
function Clampable({ text, className, threshold = 320 }: { text: string; className?: string; threshold?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > threshold;
  return (
    <div>
      <div className={`${className ?? ''} ${long && !open ? 'max-h-24 overflow-hidden' : ''}`}>
        <TranscriptMarkdown>{text}</TranscriptMarkdown>
      </div>
      {long && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 text-[11px] text-[var(--gray-10)] hover:text-[var(--gray-12)] underline"
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/** A file write/edit as a collapsed card that expands in place. */
function DocumentCard({ doc }: { doc: DocEdit }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(true); // markdown: Preview by default
  const isEdit = doc.content === undefined;
  const name = basename(doc.filePath) || doc.filePath;

  return (
    <div className="rounded-md border border-[var(--gray-5)] bg-[var(--gray-2)] overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--gray-3)]"
      >
        <ChevronRightIcon className={`size-3.5 shrink-0 text-[var(--gray-9)] transition-transform ${open ? 'rotate-90' : ''}`} />
        {isEdit ? <PencilSquareIcon className="size-4 shrink-0 text-amber-500" /> : <DocumentTextIcon className="size-4 shrink-0 text-blue-500" />}
        <span className="text-xs font-medium text-[var(--gray-12)] truncate">{isEdit ? 'Edited' : 'Wrote'} {name}</span>
        <span className="ml-auto font-mono text-[10px] text-[var(--gray-9)] truncate max-w-[45%]" title={doc.filePath}>{doc.filePath}</span>
      </button>
      {open && (
        <div className="border-t border-[var(--gray-5)] px-3 py-2">
          {doc.isMarkdown && !isEdit && (
            <div className="mb-1.5 flex gap-1 text-[11px]">
              <button onClick={() => setPreview(true)} className={`rounded px-1.5 py-0.5 ${preview ? 'bg-[var(--gray-4)] text-[var(--gray-12)]' : 'text-[var(--gray-10)] hover:text-[var(--gray-12)]'}`}>Preview</button>
              <button onClick={() => setPreview(false)} className={`rounded px-1.5 py-0.5 ${!preview ? 'bg-[var(--gray-4)] text-[var(--gray-12)]' : 'text-[var(--gray-10)] hover:text-[var(--gray-12)]'}`}>Raw</button>
            </div>
          )}
          {isEdit ? (
            <div className="max-h-80 overflow-auto rounded bg-[var(--gray-1)] border border-[var(--gray-4)] font-mono text-[11px]">
              {(doc.oldString ?? '').split('\n').map((l, i) => (
                <div key={`o${i}`} className="whitespace-pre-wrap bg-red-500/10 px-2 text-red-700 dark:text-red-300">- {l}</div>
              ))}
              {(doc.newString ?? '').split('\n').map((l, i) => (
                <div key={`n${i}`} className="whitespace-pre-wrap bg-green-500/10 px-2 text-green-700 dark:text-green-300">+ {l}</div>
              ))}
            </div>
          ) : doc.isMarkdown && preview ? (
            <div className="max-h-96 overflow-auto">
              <TranscriptMarkdown>{doc.content ?? ''}</TranscriptMarkdown>
            </div>
          ) : (
            <pre className="max-h-96 overflow-auto rounded bg-[var(--gray-1)] border border-[var(--gray-4)] px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-[var(--gray-12)]">{doc.content ?? ''}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function StepView({ step, flash }: { step: TimelineStep; flash: boolean }) {
  const flashCls = flash ? 'se-flash' : '';
  switch (step.type) {
    case 'message':
      return (
        <div className={`rounded-md px-3 py-2 border-l-2 bg-[var(--gray-2)] ${flashCls} ${
          step.role === 'admin' ? 'border-l-blue-400' : step.role === 'system' ? 'border-l-amber-400' : 'border-l-[var(--gray-6)]'
        }`}>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-10)]">{step.role}{step.subSessionId ? ` · ${step.subSessionId}` : ''}</div>
          <TranscriptMarkdown className="text-[var(--gray-12)]">{step.content}</TranscriptMarkdown>
        </div>
      );
    case 'assistant':
      return (
        <div className={`rounded-md px-3 py-2 bg-[var(--gray-2)] border-l-2 border-l-[var(--gray-6)] ${flashCls}`}>
          <div className="text-[11px] uppercase tracking-wide text-[var(--gray-10)]">agent{step.agent ? ` · ${step.agent}` : ''}</div>
          <Clampable text={step.text} className="whitespace-pre-wrap text-[var(--gray-12)]" />
        </div>
      );
    case 'tool':
      return (
        <div className={`rounded-md ${flashCls}`}>
          {step.doc ? (
            <DocumentCard doc={step.doc} />
          ) : (
            <div className="flex items-center gap-2 px-3 py-1 text-xs text-[var(--gray-11)]">
              <WrenchIcon className="size-3.5 shrink-0 text-[var(--gray-9)]" />
              <span className="text-[var(--gray-12)]">{step.label}</span>
            </div>
          )}
        </div>
      );
    case 'tool_result':
      return (
        <div className={`px-3 ${flashCls}`}>
          <Clampable text={step.summary} threshold={200} className="whitespace-pre-wrap font-mono text-[11px] text-[var(--gray-10)]" />
        </div>
      );
    case 'note':
      return (
        <div className={`flex items-start gap-2 px-3 py-0.5 text-[11px] text-[var(--gray-10)] ${flashCls}`}>
          <span className="font-mono text-[var(--gray-9)]">{step.kind}</span>
          {step.text && <span className="whitespace-pre-wrap">{step.text.slice(0, 200)}</span>}
        </div>
      );
    default:
      return null;
  }
}

export default function RunTimeline({ detail, live }: { detail: any; live: boolean }) {
  const steps = buildTimeline(detail?.events ?? [], detail?.messages ?? []);

  // Track which step keys we've already rendered so only *new* ones flash.
  const seen = useRef<Set<string>>(new Set());
  const firstPass = useRef(true);
  const flashed: Record<string, boolean> = {};
  for (const s of steps) {
    if (!seen.current.has(s.key)) {
      // Don't flash the whole history on the initial mount of a run.
      flashed[s.key] = !firstPass.current;
      seen.current.add(s.key);
    }
  }
  firstPass.current = false;

  // Reset the "seen" set when switching to a different run.
  const runId = detail?.run?.id;
  const prevRun = useRef(runId);
  if (prevRun.current !== runId) {
    seen.current = new Set(steps.map((s) => s.key));
    firstPass.current = false;
    prevRun.current = runId;
  }

  // Flash phase pills that just moved to a terminal/passed state.
  const phaseState = useRef<Record<string, string>>({});
  const phaseFlash: Record<string, boolean> = {};
  for (const p of detail?.phases ?? []) {
    const prev = phaseState.current[p.id];
    if (prev !== undefined && prev !== p.status && (p.status === 'passed' || p.status === 'failed')) {
      phaseFlash[p.id] = true;
    }
    phaseState.current[p.id] = p.status;
  }

  const activity = live ? currentActivity(steps) : null;

  return (
    // Rendered as content INSIDE the tab's transcript scroll container, which pins near-bottom by
    // scrolling only itself (never the page). The sticky ticker below sticks to that container.
    <div className="pr-2 text-sm space-y-2">
      <style>{FLASH_STYLE}</style>

      {live && (
        <div className="sticky top-0 z-10 -mx-2 mb-1 flex items-center gap-2 bg-[var(--gray-1)]/95 px-2 py-1.5 backdrop-blur border-b border-[var(--gray-4)]">
          <ArrowPathIcon className="se-spin size-4 animate-spin text-blue-500" />
          <span className="text-xs font-medium text-[var(--gray-12)] truncate">{activity}</span>
        </div>
      )}

      {steps.length === 0 ? (
        <div className="text-[var(--gray-10)] text-xs px-1 py-4">Waiting for the agent to start…</div>
      ) : (
        steps.map((s) => <StepView key={s.key} step={s} flash={!!flashed[s.key]} />)
      )}

      {/* phase pills are re-rendered by the parent header; expose flash via data attr consumers can read */}
      <PhaseFlashHints phaseFlash={phaseFlash} />
    </div>
  );
}

/**
 * The phase pills live in the parent header (kept there for layout), so we
 * surface which just changed via a small side-channel the header reads. Keeping
 * this here means all timeline-derived motion state lives in one component.
 */
function PhaseFlashHints({ phaseFlash }: { phaseFlash: Record<string, boolean> }) {
  useEffect(() => {
    for (const [id, on] of Object.entries(phaseFlash)) {
      if (!on) continue;
      const sel = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
      const el = document.querySelector(`[data-se-phase="${sel}"]`);
      if (el) {
        el.classList.remove('se-flash-pill');
        // reflow so re-adding the class restarts the animation
        void (el as HTMLElement).offsetWidth;
        el.classList.add('se-flash-pill');
      }
    }
  });
  return null;
}
