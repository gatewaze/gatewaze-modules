/**
 * AI sidebar — chat-window UX matching modern AI copilots
 * (Puck/Claude/ChatGPT). Composer pinned to the bottom, message list
 * above it. Each turn renders:
 *
 *   - User prompt as a right-aligned bubble.
 *   - Assistant ack as a left-aligned line ("Thinking…", then a
 *     completion line).
 *   - Status pill chip for the action taken ("✓ Replaced page",
 *     "✓ Updated block").
 *   - Token / cost / duration as a tiny meta line.
 *
 * On the first open we show the composer vertically centred in the
 * viewport (discoverable without scrolling) plus a few canned
 * suggestion chips. Once the user has submitted at least one prompt
 * we collapse to the standard chat layout.
 *
 * Canvas animation: instead of dispatching the merged Puck Data in a
 * single setData (which makes the canvas pop in all-at-once), we
 * progressively reveal the result block-by-block for the modes that
 * produce a visible sequence (replace/append/insert-after). The
 * server returns the full result; the pane stages the dispatches.
 * edit-block / edit don't animate (single-block change / nondescript
 * multi-edit diff).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createUsePuck } from '@puckeditor/core';
import { toast } from 'sonner';
import { useAiGenerate } from './useAiGenerate.js';
import { AiDocumentUploader, type AttachedDoc } from './AiDocumentUploader.js';
import { CanvasAiService, type HostKind, type GenerateMode, type GenerateRequest } from '../services/canvasAiService.js';
import type { PuckData } from './puck-data-merger.js';

export interface AiSidebarPaneProps {
  hostKind: HostKind;
  hostId: string;
  targetId: string;
  blockDefs?: ReadonlyArray<Record<string, unknown>>;
}

type Mode = GenerateMode;

/**
 * Infer the user's intent from the prompt text plus whether they have
 * a block selected on the canvas. No mode picker UI — the AI tab is a
 * single text-driven surface.
 *
 * Rules, evaluated top-to-bottom (first match wins):
 *
 *   1. `edit-block` — block selected AND prompt refers to "this/it/the
 *      selected/this block/this section/this heading/…" or the user
 *      typed a short editing verb (make it / change it / shorter /
 *      punchier) that's clearly about the selection.
 *   2. `insert-after` — block selected AND prompt explicitly says
 *      "after"/"below this"/"underneath"/"next to"/"insert after".
 *   3. `append` — prompt says "add"/"append"/"at the end"/"to the
 *      bottom"/"include a … at the end".
 *   4. `edit` — no selection AND prompt says "update/edit/change/fix/
 *      polish/improve/rewrite/tweak/refine" without a clear "create"
 *      verb.
 *   5. Default → `replace` (the user is asking for a fresh draft).
 *
 * Intentionally lenient: when in doubt, `replace` is the safest mode
 * because it never destroys editor state silently — the user reviews
 * the new draft before Publish, and Undo restores the prior page.
 */
function detectMode(rawPrompt: string, hasSelection: boolean): Mode {
  const t = rawPrompt.trim().toLowerCase();
  if (!t) return hasSelection ? 'edit-block' : 'replace';

  const mentionsSelection =
    /\b(this|that|it|the (selected|current|chosen)|this block|this section|this column|this row|this heading|this image|this card|this button|this text|the headline|the subhead|selected block)\b/.test(t);

  // 2) insert-after — explicit "after this" / "below this" / etc.
  if (hasSelection && /\b(insert (after|below|underneath)|after (this|that|it)|below (this|that|it)|underneath|right after|next to (this|that|it))\b/.test(t)) {
    return 'insert-after';
  }

  // 3) append — "add … at the end / to the bottom / append".
  if (/\b(append|at the (end|bottom)|to the (end|bottom)|at end|add (a |an |another )?(?:.+? )?at the (end|bottom))\b/.test(t)) {
    return 'append';
  }
  // "add a/an X" (without "at the end") is ambiguous — treat as append
  // when there is NO selection (interpreting as "extend the page with
  // a new block"); when there IS a selection, leave it for the next
  // rule to decide.
  if (!hasSelection && /\b(add (a|an|another) (?!image|photo|attachment)\b)/.test(t)) {
    return 'append';
  }

  // 1) edit-block — referring to the selected block (or short edit verb
  //    when something is selected).
  if (hasSelection) {
    if (mentionsSelection) return 'edit-block';
    // Very short prompts with an edit verb are almost always about the
    // selection (e.g. "punchier", "shorter", "more formal").
    if (t.length < 40 && /^(make (it|this) |punchier|shorter|longer|more |less |fix |polish |rewrite |tweak |refine |update )/.test(t)) {
      return 'edit-block';
    }
  }

  // 4) edit — no selection, but the prompt is about modifying an
  //    existing page. Three signals trigger this:
  //    a) explicit edit verb + page/edition/newsletter noun
  //    b) bug-report-style observation about duplicates / errors /
  //       missing content ("two footers", "duplicate", "missing X",
  //       "there's a problem")
  //    c) remove/delete imperatives without specifying a selection
  const editVerbOnPage = /\b(update|edit|change|fix|polish|improve|rewrite|tweak|refine|revise|adjust|reword) (the |this )?(page|edition|newsletter|copy|content|email)\b/.test(t);
  const problemObservation = /\b(two |duplicate|extra |missing |broken|wrong|conflict|seem to have|appear to have|seems to have|there'?s (an?|two|some|a problem|an? issue|a bug|a duplicate))\b/.test(t);
  const removeImperative = /\b(remove|delete|get rid of|take out|drop) (the|that|a|an|one of|both)\b/.test(t);
  if (!hasSelection && (editVerbOnPage || problemObservation || removeImperative)) {
    return 'edit';
  }

  // 5) default — fresh draft when the prompt sounds like creation
  //    ("create / make / build / write / draft / generate"), else
  //    lean conservative on a non-empty page (edit). We don't know
  //    the page emptiness here — that signal lives one level up and
  //    can be threaded in later. For now, default to `replace` for
  //    no-selection / `edit-block` for selection.
  return hasSelection ? 'edit-block' : 'replace';
}

// Friendly verb for the pending status chip / "Working on …" line.
const MODE_VERB: Record<Mode, string> = {
  replace: 'Drafting page',
  append: 'Appending content',
  'insert-after': 'Inserting after selection',
  edit: 'Editing page',
  'edit-block': 'Editing selected block',
};

const usePuck = createUsePuck();

interface ItemSelector {
  index: number;
  zone?: string;
}

interface MinimalPuckData {
  content: Array<{ props: { id: string } }>;
  root: { props: Record<string, unknown> };
}

interface UserMessage {
  id: string;
  kind: 'user';
  text: string;
}
interface AssistantMessage {
  id: string;
  kind: 'assistant';
  text: string;
}
interface StatusMessage {
  id: string;
  kind: 'status';
  label: string;
  state: 'pending' | 'success' | 'error';
}
interface MetaMessage {
  id: string;
  kind: 'meta';
  tokens: number;
  cost_approx: number;
  duration_ms: number;
}
type ChatMessage = UserMessage | AssistantMessage | StatusMessage | MetaMessage;

// ---------------------------------------------------------------------------
// styles
// ---------------------------------------------------------------------------

const S = {
  // Parent-relative heights only — 100vh would force the surrounding
  // Puck shell taller than the viewport, requiring a page scroll to
  // reach the bottom of the editor. The Puck sidebar gives each tab a
  // flex-filled box; filling it with `height: 100%` centres the
  // composer within whatever the sidebar's actual height is (≈
  // viewport height when Puck respects the viewport).
  rootInitial: {
    display: 'flex',
    flexDirection: 'column',
    // Anchor the composer + suggestion chips to the bottom of the
    // sidebar — matches the in-chat composer position so the prompt
    // input doesn't visually jump down once the user submits.
    justifyContent: 'flex-end',
    height: '100%',
    minHeight: 0,
    padding: 12,
    gap: 12,
    fontSize: 13,
    lineHeight: 1.4,
    color: 'var(--puck-color-grey-02, #1f2937)',
    boxSizing: 'border-box',
  } as CSSProperties,
  rootChat: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    padding: 0,
    fontSize: 13,
    lineHeight: 1.45,
    color: 'var(--puck-color-grey-02, #1f2937)',
    boxSizing: 'border-box',
  } as CSSProperties,

  headerBar: {
    padding: '12px 14px 10px',
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--puck-color-grey-01, #111827)',
    borderBottom: '1px solid var(--puck-color-grey-09, #e5e7eb)',
  } as CSSProperties,

  messages: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '14px 14px 8px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
    minHeight: 0,
  } as CSSProperties,

  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    padding: '8px 12px',
    fontSize: 13,
    lineHeight: 1.45,
    color: 'var(--puck-color-grey-02, #1f2937)',
    background: 'var(--puck-color-azure-10, #e0e7ff)',
    borderRadius: 14,
    borderTopRightRadius: 4,
    wordBreak: 'break-word' as const,
  } as CSSProperties,

  assistantLine: {
    alignSelf: 'flex-start',
    maxWidth: '95%',
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--puck-color-grey-03, #374151)',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
  } as CSSProperties,

  statusChipBase: {
    alignSelf: 'flex-start',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px 6px 8px',
    fontSize: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'solid',
  } as CSSProperties,
  statusChipPending: {
    borderColor: 'var(--puck-color-grey-09, #e5e7eb)',
    background: 'var(--puck-color-grey-12, #f9fafb)',
    color: 'var(--puck-color-grey-04, #4b5563)',
  } as CSSProperties,
  statusChipSuccess: {
    borderColor: 'var(--puck-color-grey-09, #d1fae5)',
    background: 'var(--puck-color-white, #fff)',
    color: 'var(--puck-color-grey-03, #065f46)',
  } as CSSProperties,
  statusChipError: {
    borderColor: '#fecaca',
    background: '#fef2f2',
    color: '#991b1b',
  } as CSSProperties,

  metaLine: {
    alignSelf: 'flex-start',
    fontSize: 11,
    color: 'var(--puck-color-grey-05, #9ca3af)',
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,

  footer: {
    padding: '8px 12px 12px',
    borderTop: '1px solid var(--puck-color-grey-09, #e5e7eb)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  } as CSSProperties,
  footerInitial: {
    padding: 0,
    borderTop: 'none',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  } as CSSProperties,

  composer: {
    display: 'flex',
    flexDirection: 'column' as const,
    borderWidth: 1,
    borderStyle: 'solid' as const,
    borderColor: 'var(--puck-color-grey-08, #d1d5db)',
    borderRadius: 14,
    background: 'var(--puck-color-white, #fff)',
    overflow: 'hidden' as const,
    transition: 'border-color 120ms ease, box-shadow 120ms ease',
  } as CSSProperties,
  composerFocused: {
    borderColor: 'var(--puck-color-azure-04, #1f3a93)',
    boxShadow: '0 0 0 1px var(--puck-color-azure-04, #1f3a93)',
  } as CSSProperties,

  textarea: {
    width: '100%',
    minHeight: 56,
    maxHeight: 260,
    padding: '12px 14px',
    fontFamily: 'inherit',
    fontSize: 13,
    lineHeight: 1.45,
    color: 'inherit',
    background: 'transparent',
    border: 'none',
    outline: 'none',
    resize: 'none' as const,
    boxSizing: 'border-box' as const,
  } as CSSProperties,

  actionsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 8px 8px 8px',
  } as CSSProperties,

  iconButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    padding: 0,
    background: 'transparent',
    borderWidth: 1,
    borderStyle: 'solid' as const,
    borderColor: 'transparent',
    borderRadius: 8,
    cursor: 'pointer',
    color: 'var(--puck-color-grey-04, #4b5563)',
  } as CSSProperties,
  iconButtonActive: {
    background: 'var(--puck-color-azure-09, #eef2ff)',
    color: 'var(--puck-color-azure-04, #1f3a93)',
  } as CSSProperties,

  modeHint: {
    fontSize: 11,
    color: 'var(--puck-color-grey-05, #6b7280)',
    fontStyle: 'italic' as const,
    marginLeft: 4,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
    flex: '0 1 auto',
    minWidth: 0,
  } as CSSProperties,

  sendButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    marginLeft: 'auto',
    padding: 0,
    fontSize: 13,
    color: 'var(--puck-color-white, #fff)',
    background: 'var(--puck-color-azure-04, #1f3a93)',
    borderWidth: 1,
    borderStyle: 'solid' as const,
    borderColor: 'transparent',
    borderRadius: '50%' as const,
    cursor: 'pointer',
  } as CSSProperties,
  sendButtonDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed' as const,
  } as CSSProperties,

  attachPanel: {
    marginTop: 8,
    padding: 10,
    borderWidth: 1,
    borderStyle: 'solid' as const,
    borderColor: 'var(--puck-color-grey-09, #e5e7eb)',
    borderRadius: 10,
    background: 'var(--puck-color-grey-12, #f9fafb)',
  } as CSSProperties,

  attachedRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 6,
  } as CSSProperties,
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px 4px 10px',
    fontSize: 11,
    color: 'var(--puck-color-grey-03, #374151)',
    background: 'var(--puck-color-grey-11, #f3f4f6)',
    borderWidth: 1,
    borderStyle: 'solid' as const,
    borderColor: 'var(--puck-color-grey-09, #e5e7eb)',
    borderRadius: 999,
    maxWidth: '100%',
  } as CSSProperties,
  chipRemove: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 14,
    height: 14,
    padding: 0,
    color: 'var(--puck-color-grey-05, #6b7280)',
    background: 'transparent',
    border: 'none',
    borderRadius: '50%' as const,
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
  } as CSSProperties,
  chipName: {
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
    maxWidth: 160,
  } as CSSProperties,

};

// ---------------------------------------------------------------------------
// icons
// ---------------------------------------------------------------------------

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}
function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
function SpinnerDots() {
  return (
    <span aria-hidden="true" style={{ display: 'inline-flex', gap: 3 }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: 'currentColor',
            animation: `ai-dot-blink 900ms ${i * 150}ms infinite ease-in-out`,
            opacity: 0.6,
          }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function statusLabelFor(mode: Mode): string {
  switch (mode) {
    case 'replace': return 'Replaced page';
    case 'append': return 'Appended blocks';
    case 'insert-after': return 'Inserted blocks';
    case 'edit': return 'Edited page';
    case 'edit-block': return 'Updated block';
  }
}

// Reveal one new block at a time. For modes that produce a list of new
// content (replace/append/insert-after), we dispatch the merged data
// progressively — first with just the new range's first item, then
// adding one more on each tick. Other modes apply atomically.
async function dispatchAnimated(args: {
  mode: Mode;
  prev: PuckData;
  next: PuckData;
  anchorBlockId?: string;
  dispatch: (action: { type: 'setData'; data: PuckData }) => void;
  signal: AbortSignal;
  perBlockMs?: number;
}): Promise<void> {
  const { mode, prev, next, anchorBlockId, dispatch, signal, perBlockMs = 110 } = args;

  // Determine which slice of `next.content` is "newly revealed" so we
  // only animate the new range — keeping any existing surrounding
  // blocks stable in the DOM during the animation.
  let startIdx: number;
  let endIdx: number;
  if (mode === 'replace') {
    startIdx = 0;
    endIdx = next.content.length;
  } else if (mode === 'append') {
    startIdx = prev.content.length;
    endIdx = next.content.length;
  } else if (mode === 'insert-after') {
    const anchorPos = anchorBlockId
      ? prev.content.findIndex((b) => b.props.id === anchorBlockId)
      : prev.content.length - 1;
    startIdx = anchorPos + 1;
    // New blocks live between anchor+1 and (anchor+1 + (next.length - prev.length)).
    endIdx = startIdx + (next.content.length - prev.content.length);
  } else {
    // edit / edit-block — no progressive reveal; apply atomically.
    dispatch({ type: 'setData', data: next });
    return;
  }

  // Sanity: if the slice math is degenerate, fall back to atomic apply.
  if (endIdx <= startIdx) {
    dispatch({ type: 'setData', data: next });
    return;
  }

  for (let i = startIdx; i < endIdx; i++) {
    if (signal.aborted) return;
    const partialContent = [
      ...next.content.slice(0, i + 1),
      // Tail after the revealed range stays as it was in prev (for
      // insert-after) or empty (for replace/append, which have nothing
      // after the new range).
      ...(mode === 'insert-after'
        ? next.content.slice(endIdx)
        : []),
    ];
    dispatch({
      type: 'setData',
      data: {
        content: partialContent,
        root: next.root,
      },
    });
    if (i < endIdx - 1) {
      await new Promise((r) => setTimeout(r, perBlockMs));
    }
  }
  // Final pass — ensure the canonical merged state is on canvas.
  if (!signal.aborted) dispatch({ type: 'setData', data: next });
}

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

export function AiSidebarPane(props: AiSidebarPaneProps) {
  const itemSelector = usePuck(
    (s) => (s.appState as unknown as { ui: { itemSelector?: ItemSelector | null } }).ui.itemSelector ?? null,
  );
  const currentData = usePuck(
    (s) => (s.appState as unknown as { data: MinimalPuckData }).data,
  );
  const dispatch = usePuck((s) => s.dispatch);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Prompts typed while a turn is running are parked here and sent one
  // at a time once the canvas is free (Claude-Code-style queueing).
  const [queued, setQueued] = useState<string[]>([]);
  const drainLockRef = useRef(false);
  const [prompt, setPrompt] = useState('');
  const [attached, setAttached] = useState<AttachedDoc[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const animationAbortRef = useRef<AbortController | null>(null);

  const selectedBlockId = useMemo<string | null>(() => {
    if (!itemSelector || !currentData) return null;
    const item = currentData.content[itemSelector.index];
    return item?.props.id ?? null;
  }, [itemSelector, currentData]);

  // Mode is no longer a separate user-controlled state — we infer it
  // from the prompt text and the current selection at submit time
  // (and re-derive for the UI hint as the user types).
  const previewMode = useMemo<Mode>(
    () => detectMode(prompt, !!selectedBlockId),
    [prompt, selectedBlockId],
  );

  // Auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`;
  }, [prompt]);

  // Auto-scroll messages to bottom when new ones arrive.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, queued.length]);

  // On mount (and when the target changes) rehydrate the transcript from
  // the DB so the conversation survives a page reload. Only applied when
  // the pane is still empty, so an in-flight turn is never clobbered.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const history = await CanvasAiService.loadThread({
          host_kind: props.hostKind,
          host_id: props.hostId,
          target_id: props.targetId,
        });
        if (!cancelled && history.length > 0) {
          setMessages((prev) => (prev.length === 0 ? history : prev));
        }
      } catch {
        // Non-fatal — start with an empty transcript.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.hostKind, props.hostId, props.targetId]);

  const { status, error, warnings, lastUsage, generate, abort } = useAiGenerate();

  // Reflect hook state changes into the chat (server status → chat messages).
  useEffect(() => {
    if (status === 'error' && error) {
      setMessages((prev) => updatePendingStatus(prev, {
        state: 'error',
        label: `Error: ${error.code}`,
      }).concat({
        id: newId('asst'),
        kind: 'assistant',
        text: error.message,
      }));
    }
  }, [status, error]);

  useEffect(() => {
    if (status === 'success' && warnings.length > 0) {
      for (const w of warnings) {
        const msg = typeof w === 'string' ? w : `${w.code}: ${w.message}`;
        toast.warning(msg);
      }
    }
  }, [status, warnings]);

  const submitPrompt = useCallback(async (rawText: string) => {
    const text = rawText.trim();
    if (!text || status === 'loading') return;
    if (!currentData) {
      toast.error('AI: no canvas data');
      return;
    }

    // Infer the mode at submit time from the prompt + current selection.
    // The user no longer picks; the AI tab is a single text-driven
    // surface. detectMode falls back to safe defaults (`edit-block`
    // when a block is selected and the intent is ambiguous, otherwise
    // `replace`).
    let mode: Mode = detectMode(text, !!selectedBlockId);

    // Safety: if the inference picked a mode that requires a selection
    // but the user has none, demote to a non-selection mode rather
    // than blocking the request — the editor heuristic occasionally
    // matches "after" / "this" in prose that wasn't really referring
    // to the selection.
    if (mode === 'insert-after' && !selectedBlockId) mode = 'append';
    if (mode === 'edit-block' && !selectedBlockId) mode = 'edit';

    const userMsg: UserMessage = { id: newId('user'), kind: 'user', text };
    const pendingMsg: AssistantMessage = {
      id: newId('asst'),
      kind: 'assistant',
      text: `${MODE_VERB[mode]}…`,
    };
    const pendingStatus: StatusMessage = {
      id: newId('stat'),
      kind: 'status',
      label: statusLabelFor(mode),
      state: 'pending',
    };
    setMessages((prev) => [...prev, userMsg, pendingMsg, pendingStatus]);
    setPrompt('');

    const request: GenerateRequest = {
      host_kind: props.hostKind,
      host_id: props.hostId,
      target_id: props.targetId,
      prompt: text,
      mode,
      ...(mode === 'insert-after' && selectedBlockId ? { anchorBlockId: selectedBlockId } : {}),
      ...(mode === 'edit-block' && selectedBlockId ? { blockId: selectedBlockId } : {}),
      ...(attached.length > 0 ? { doc_ids: attached.map((d) => d.doc_id) } : {}),
      ...(props.blockDefs && props.blockDefs.length > 0
        ? { block_defs: props.blockDefs as ReadonlyArray<Record<string, unknown>> }
        : {}),
    };

    // Cancel any in-flight animation from a previous turn.
    animationAbortRef.current?.abort();
    const animationController = new AbortController();
    animationAbortRef.current = animationController;

    const prevSnapshot = currentData as unknown as PuckData;

    await generate({
      currentData: currentData as never,
      request,
      onApply: (merged) => {
        // Progressive reveal — block-by-block for sequence-producing
        // modes, atomic for edits.
        void dispatchAnimated({
          mode,
          prev: prevSnapshot,
          next: merged,
          ...(mode === 'insert-after' && selectedBlockId ? { anchorBlockId: selectedBlockId } : {}),
          dispatch: dispatch as never,
          signal: animationController.signal,
        });

        // Flip the pending status to success and append a follow-up
        // assistant line + meta. The hook will populate `lastUsage`
        // shortly after; we read it from a stale closure here, so use
        // the merged data length for the human-readable count instead.
        const newCount = mode === 'replace'
          ? merged.content.length
          : merged.content.length - prevSnapshot.content.length;
        setMessages((prev) => updatePendingStatus(prev, {
          state: 'success',
          label:
            mode === 'edit-block'
              ? 'Updated block'
              : mode === 'edit'
              ? 'Edited page'
              : `${statusLabelFor(mode)} (${newCount} block${newCount === 1 ? '' : 's'})`,
        }).concat({
          id: newId('asst'),
          kind: 'assistant',
          text: 'Done. What would you like next?',
        }));
      },
    });
  }, [
    status,
    currentData,
    selectedBlockId,
    attached,
    props.hostKind,
    props.hostId,
    props.targetId,
    props.blockDefs,
    generate,
    dispatch,
  ]);

  // Meta line — once `lastUsage` arrives, append it as a meta message
  // attached to the last status (only once per generation).
  const lastUsageAddedRef = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 'success' || !lastUsage) return;
    const key = `${lastUsage.tokens}:${lastUsage.duration_ms}`;
    if (lastUsageAddedRef.current === key) return;
    lastUsageAddedRef.current = key;
    setMessages((prev) => [
      ...prev,
      {
        id: newId('meta'),
        kind: 'meta',
        tokens: lastUsage.tokens,
        cost_approx: lastUsage.cost_approx,
        duration_ms: lastUsage.duration_ms,
      },
    ]);
  }, [status, lastUsage]);

  // Drain queued prompts one at a time once the active turn settles, so
  // messages typed while a turn was running send automatically in order.
  // The canvas can only safely apply one generation at a time, so we
  // never run them concurrently.
  useEffect(() => {
    if (drainLockRef.current) return;
    if (status === 'loading') return;
    if (queued.length === 0) return;
    drainLockRef.current = true;
    const [next, ...rest] = queued;
    setQueued(rest);
    void submitPrompt(next!).finally(() => {
      drainLockRef.current = false;
    });
  }, [status, queued, submitPrompt]);

  const onSubmit = useCallback(() => {
    const text = prompt.trim();
    if (!text) return;
    // Queue while a turn is running (or others are already waiting) and
    // let the drain effect send them sequentially.
    if (status === 'loading' || queued.length > 0) {
      setQueued((q) => [...q, text]);
      setPrompt('');
      return;
    }
    void submitPrompt(prompt);
  }, [prompt, status, queued.length, submitPrompt]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onSubmit();
      } else if (e.key === 'Escape' && status === 'loading') {
        abort();
        animationAbortRef.current?.abort();
      }
    },
    [onSubmit, status, abort],
  );

  const placeholder = selectedBlockId
    ? 'Make this block punchier, more concise, friendlier…'
    : `What do you want to build?`;

  const isInitial = messages.length === 0 && status === 'idle';
  const isLoading = status === 'loading';
  // The composer stays usable while a turn runs — submitting queues.
  const canSend = !!prompt.trim();
  // The send button only doubles as cancel when there's nothing to queue.
  const showCancel = isLoading && !prompt.trim();

  const composer = (
    <>
      <div style={{ ...S.composer, ...(composerFocused ? S.composerFocused : {}) }}>
        <textarea
          ref={textareaRef}
          rows={2}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setComposerFocused(true)}
          onBlur={() => setComposerFocused(false)}
          placeholder={placeholder}
          maxLength={2000}
          style={S.textarea}
          autoFocus={isInitial}
        />
        <div style={S.actionsRow}>
          <button
            type="button"
            aria-label={attachOpen ? 'Hide source attachments' : 'Attach a source document or URL'}
            title="Attach source"
            onClick={() => setAttachOpen((v) => !v)}
            style={{ ...S.iconButton, ...(attachOpen ? S.iconButtonActive : {}) }}
          >
            <PlusIcon />
          </button>

          {/* Inline mode hint — derived from the prompt + selection.
              Subtle so it doesn't read as a control; visible enough that
              the user can sanity-check what's about to happen before
              they hit send. Hidden when the textarea is empty (no
              inference yet) to keep the resting state clean. */}
          {prompt.trim().length > 0 && (
            <span
              aria-label={`Detected mode: ${MODE_VERB[previewMode]}`}
              title="The AI inferred what you want to do from your prompt."
              style={S.modeHint}
            >
              {MODE_VERB[previewMode]}
            </span>
          )}

          <button
            type="button"
            aria-label={showCancel ? 'Cancel generation' : isLoading ? 'Queue prompt' : 'Send prompt'}
            title={isLoading && prompt.trim() ? 'Will send when the current turn finishes' : undefined}
            onClick={showCancel ? () => { abort(); animationAbortRef.current?.abort(); } : onSubmit}
            disabled={!showCancel && !canSend}
            style={{ ...S.sendButton, ...(!showCancel && !canSend ? S.sendButtonDisabled : {}) }}
          >
            {showCancel ? '×' : <SendIcon />}
          </button>
        </div>
      </div>

      {attachOpen && (
        <div style={S.attachPanel}>
          <AiDocumentUploader
            hostKind={props.hostKind}
            hostId={props.hostId}
            targetId={props.targetId}
            attached={attached}
            onAttach={(d) => setAttached((prev) => [...prev, d])}
            onRemove={(id) => setAttached((prev) => prev.filter((p) => p.doc_id !== id))}
          />
        </div>
      )}

      {attached.length > 0 && (
        <div style={S.attachedRow}>
          {attached.map((d) => (
            <span key={d.doc_id} style={S.chip}>
              <span style={S.chipName} title={d.filename}>{d.filename}</span>
              <button
                type="button"
                aria-label={`Remove ${d.filename}`}
                onClick={() => setAttached((prev) => prev.filter((p) => p.doc_id !== d.doc_id))}
                style={S.chipRemove}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );

  // Initial state — composer centered in viewport with suggestion chips
  // below. Once the first prompt has been submitted we switch to the
  // chat layout below.
  if (isInitial) {
    return (
      <div style={S.rootInitial} role="region" aria-label="AI copilot">
        <style>{KEYFRAMES_CSS}</style>
        <div style={S.footerInitial}>
          {composer}
        </div>
      </div>
    );
  }

  return (
    <div style={S.rootChat} role="region" aria-label="AI copilot">
      <style>{KEYFRAMES_CSS}</style>
      <div style={S.headerBar}>
        AI {props.hostKind === 'newsletter' ? 'newsletter' : 'page'} builder
      </div>

      <div style={S.messages} aria-live="polite">
        {messages.map((m) => renderMessage(m))}
        {queued.map((q, i) => (
          <div key={`queued-${i}`} style={{ ...S.userBubble, opacity: 0.5 }}>
            {q}
            <span style={{ display: 'block', fontSize: 11, opacity: 0.85, marginTop: 2 }}>queued</span>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div style={S.footer}>
        {composer}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// rendering helpers
// ---------------------------------------------------------------------------

function renderMessage(m: ChatMessage): ReactNode {
  switch (m.kind) {
    case 'user':
      return (
        <div key={m.id} style={S.userBubble}>
          {m.text}
        </div>
      );
    case 'assistant':
      return (
        <div key={m.id} style={S.assistantLine}>
          {m.text}
        </div>
      );
    case 'status': {
      const chipStyle =
        m.state === 'pending'
          ? S.statusChipPending
          : m.state === 'error'
          ? S.statusChipError
          : S.statusChipSuccess;
      return (
        <div key={m.id} style={{ ...S.statusChipBase, ...chipStyle }}>
          {m.state === 'pending' ? <SpinnerDots /> : m.state === 'success' ? <CheckIcon /> : null}
          <span>{m.label}</span>
        </div>
      );
    }
    case 'meta':
      return (
        <div key={m.id} style={S.metaLine}>
          {m.tokens.toLocaleString()} tokens · ${m.cost_approx.toFixed(3)} ·{' '}
          {(m.duration_ms / 1000).toFixed(1)}s
        </div>
      );
  }
}

function updatePendingStatus(
  messages: ChatMessage[],
  patch: { state: 'success' | 'error'; label?: string },
): ChatMessage[] {
  // Patch the most recent `status` message that's still 'pending'.
  // Walk from the end of the list — there can only be one in-flight
  // generation at a time, so this is safe.
  let foundIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.kind === 'status' && m.state === 'pending') {
      foundIdx = i;
      break;
    }
  }
  if (foundIdx === -1) return messages;
  const target = messages[foundIdx] as StatusMessage;
  const next: StatusMessage = {
    ...target,
    state: patch.state,
    label: patch.label ?? target.label,
  };
  return [...messages.slice(0, foundIdx), next, ...messages.slice(foundIdx + 1)];
}

const KEYFRAMES_CSS = `
  @keyframes ai-dot-blink {
    0%, 80%, 100% { opacity: 0.25; transform: scale(0.85); }
    40% { opacity: 1; transform: scale(1); }
  }
`;
