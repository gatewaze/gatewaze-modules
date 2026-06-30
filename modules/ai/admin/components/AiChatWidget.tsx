/**
 * AiChatWidget — public-facing React component consumed by host modules.
 *
 * Built on assistant-ui's composable primitives + a Gatewaze runtime
 * adapter that bridges to our async REST API:
 *   1. Mount → lookup or create the thread.
 *   2. Hydrate messages.
 *   3. Build an ExternalStoreAdapter so assistant-ui can drive the UI.
 *   4. POST /messages → 202 + placeholder → poll until status='complete'.
 *
 * Host modules supply `renderAssistantTurn` to render structured-output
 * turns (CandidateCards for daily-briefing, BlockMergePreview for editor
 * copilot, etc.). Plain narrative turns get assistant-ui's default text
 * bubble.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import {
  ArrowPathIcon,
  PaperAirplaneIcon,
  SparklesIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';

import {
  cancelMessage,
  createThread,
  deleteThread,
  getThread,
  listUseCaseModels,
  lookupThread,
  microUsdToDollars,
  postMessage,
  type AiAutoOrProvider,
  type AiMessage,
  type AiModelInfo,
  type AiProvider,
  type AiThread,
} from '../utils/aiService';
import ConfiguredPromptBar from './ConfiguredPromptBar';
import RunDetails from './RunDetails';

const POLL_INTERVAL_MS = 4_000;
const POLL_BACKOFF_AT_MS = 60_000;
const POLL_LONG_BACKOFF_AT_MS = 180_000;

export interface AiChatWidgetProps {
  useCase: string;
  hostKind: string;
  hostId: string;
  threadKey?: string;
  /**
   * Host module renders structured-output assistant turns (e.g.
   * candidate cards, block-merge preview). Returns `null` to fall back
   * to the default text bubble.
   */
  renderAssistantTurn?: (message: AiMessage) => React.ReactNode | null;
  defaultProvider?: AiAutoOrProvider;
  defaultModel?: string;
  /** Show the model picker in the widget header. */
  modelPicker?: boolean;
  /** Optional hook called after each assistant turn lands. */
  onAssistantMessage?: (message: AiMessage) => void;
  /**
   * Set when the widget is mounted inside a wrapper that already provides
   * the outer border + rounding (e.g. AiChatModelTabs). Drops the
   * widget's own border, rounded corners, and tinted background so
   * nested borders don't appear as doubled corners.
   */
  embedded?: boolean;
  /**
   * Per-tab sub-recipe override path (controlled value). When set,
   * each postMessage call forwards it to the chat handler, which
   * uses the named recipe's instructions + schema. `null` means
   * "use the chat handler's default (first sub-recipe of the bound
   * parent recipe)". Lifted up so the parent (AiChatModelTabs) can
   * read each tab's override for the per-tab "Run on <model>" button.
   */
  recipeOverride?: string | null;
  onRecipeOverrideChange?: (path: string | null) => void;
  /**
   * Hide the composer — the thread becomes a read-only transcript. Used for
   * tabs that only display content posted by another process (e.g.
   * lunch-and-learn's per-model draft tabs).
   */
  readOnly?: boolean;
}

export default function AiChatWidget(props: AiChatWidgetProps) {
  const {
    useCase,
    hostKind,
    hostId,
    threadKey = '',
    renderAssistantTurn,
    defaultProvider = 'auto',
    defaultModel,
    modelPicker = true,
    onAssistantMessage,
    embedded = false,
    recipeOverride = null,
    onRecipeOverrideChange,
    readOnly = false,
  } = props;

  const [thread, setThread] = useState<AiThread | null>(null);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  // Claude-Code-style send-while-running queue. Messages the operator
  // submits while an assistant turn is in flight are parked here and
  // drained one-at-a-time after the current run completes (the
  // backend rejects concurrent runs on a thread with 409 thread_busy,
  // so we serialise client-side rather than firing them in parallel).
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  // Re-entrancy lock for the drain effect: set synchronously the
  // moment we start sending a queued message so a re-render in the
  // async gap before `sending` flips can't pop a second item.
  const drainLockRef = useRef(false);
  const [provider, setProvider] = useState<AiAutoOrProvider>(defaultProvider);
  const [model, setModel] = useState<string | undefined>(defaultModel);
  const [models, setModels] = useState<AiModelInfo[]>([]);
  // Live token buffer fed by the SSE stream while an assistant
  // message is running. Cleared when the message transitions to
  // `complete` (the poll picks up the canonical content row).
  const [liveContent, setLiveContent] = useState<string>('');
  // Auto-scroll the message list to the bottom whenever new content
  // arrives (tool calls, token deltas, completed messages). Skipped
  // when the operator has scrolled up — detected by checking whether
  // the current scroll position is within ~80px of the bottom before
  // we update. Mirrors ChatGPT/Claude's "stick to bottom unless the
  // user opts out" behaviour.
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  // Past actions for this run, oldest first. Each tool/run.start
  // event appends one entry; the bottom-most bubble is what's
  // happening right now and carries the spinner. Capped at 100 to
  // keep the DOM tractable for long Sonnet runs (90+ tool calls
  // observed in the daily-briefing-research recipe).
  const [liveEvents, setLiveEvents] = useState<Array<{ id: string; text: string }>>([]);
  const liveEventCounter = useRef(0);
  const pushLiveEvent = (text: string): void => {
    liveEventCounter.current += 1;
    const id = `${Date.now()}-${liveEventCounter.current}`;
    setLiveEvents((prev) => {
      const next = [...prev, { id, text }];
      return next.length > 100 ? next.slice(next.length - 100) : next;
    });
  };
  // Optional status text fed by run.start / tool.* events so the
  // operator sees what the agent is doing right now ("searching X",
  // "fetching url …") rather than a blank "Thinking…".

  // ── Hydrate thread on mount ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      setLoading(true);
      try {
        const existing = await lookupThread({ useCase, hostKind, hostId, threadKey });
        const t = existing ?? (await createThread({ useCase, hostKind, hostId, threadKey }));
        if (cancelled) return;
        setThread(t);
        const full = await getThread(t.id);
        if (cancelled) return;
        setMessages(full.messages);
      } catch (err) {
        console.error('[ai-chat] hydrate failed', err);
        toast.error('Failed to load chat');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void hydrate();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useCase, hostKind, hostId, threadKey]);

  // ── Load available models for the picker ───────────────────────────
  useEffect(() => {
    if (!modelPicker) return;
    listUseCaseModels(useCase)
      .then(setModels)
      .catch((err) => console.warn('[ai-chat] model list load failed', err));
  }, [useCase, modelPicker]);

  // ── Poll the thread on a continuous cadence ─────────────────────────
  // Two reasons for unconditional polling rather than gating on "a
  // local message is running":
  //   1. Externally-triggered runs (daily-briefing's "Run autopilot"
  //      fan-out, the cron, a webhook-fired sync) insert a `running`
  //      assistant placeholder server-side AFTER the widget has
  //      hydrated. The old guard returned early because the widget's
  //      local messages list had no running entry — so the operator
  //      never saw the progress turn up.
  //   2. The active tab is the only one visible at any time, but
  //      every other tab stays mounted with display:none and keeps
  //      polling, which is exactly what we want for fan-out: each tab
  //      discovers its model's progress independently.
  //
  // Cadence: 4s while a message is running, 8s otherwise. Bounded
  // backoff for long-running runs avoids hammering the API once a
  // research turn settles into its multi-minute web_search loop.
  const runningStartedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!thread) return;
    const hasRunning = messages.some((m) => m.status === 'running');
    if (hasRunning) {
      if (runningStartedAt.current == null) runningStartedAt.current = Date.now();
    } else {
      runningStartedAt.current = null;
    }
    const elapsed = runningStartedAt.current == null
      ? 0
      : Date.now() - runningStartedAt.current;
    const interval = hasRunning
      ? (elapsed > POLL_LONG_BACKOFF_AT_MS
          ? POLL_INTERVAL_MS * 4
          : elapsed > POLL_BACKOFF_AT_MS
            ? POLL_INTERVAL_MS * 2
            : POLL_INTERVAL_MS)
      : POLL_INTERVAL_MS * 2; // 8s background poll when idle

    let cancelled = false;
    const tick = async () => {
      if (!thread || cancelled) return;
      try {
        const result = await getThread(thread.id);
        if (cancelled) return;
        setThread(result.thread);
        setMessages(result.messages);
        // Fire the assistant-message callback once per completion.
        const justCompleted = result.messages.find(
          (m) =>
            m.role === 'assistant' &&
            m.status === 'complete' &&
            !messages.some(
              (existing) =>
                existing.id === m.id && existing.status === 'complete',
            ),
        );
        if (justCompleted && onAssistantMessage) {
          onAssistantMessage(justCompleted);
        }
      } catch (err) {
        console.warn('[ai-chat] poll failed', err);
      }
    };
    const id = setInterval(() => void tick(), interval);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, thread?.id]);

  // ── Live SSE stream ─────────────────────────────────────────────────
  // The platform exposes /api/modules/ai/admin/threads/:id/stream as an
  // SSE feed of Redis-stream events emitted by the chat / recipe worker
  // (token deltas, run.start, run.complete, tool.* status events). We
  // open the EventSource whenever an assistant message is running and
  // tear it down when the run completes — saves an idle socket per tab
  // and matches the polling effect's lifecycle.
  //
  // Events feed two pieces of UI state:
  //   - liveContent  — accumulated text deltas, rendered as the
  //                     running-message bubble so the operator sees
  //                     output build up in real time
  //   - liveStatus   — short status line ("searching ...", "tool ...")
  //                     so the spinner has a label instead of just
  //                     "Thinking…"
  // The canonical content lands on ai_messages.content when the worker
  // finishes; the polling effect overwrites both pieces of local state
  // at that point.
  const hasRunningMessage = useMemo(
    () => messages.some((m) => m.status === 'running'),
    [messages],
  );
  useEffect(() => {
    if (!thread || !hasRunningMessage) {
      setLiveContent('');
      setLiveEvents([]);
      return;
    }
    setLiveContent('');
    setLiveEvents([]);
    let es: EventSource | null = null;
    let cancelled = false;
    // EventSource can't carry custom headers, so we grab the
    // current Supabase access token and pass it as ?access_token=
    // — the platform's extractToken accepts that.
    void (async () => {
      try {
        // Pull the access token from the same Supabase client the
        // admin app uses — admins have it in localStorage via
        // supabase-js's default storage. We then pass it as a query
        // string because EventSource can't carry custom headers.
        const { supabase: sb } = await import('@/lib/supabase');
        const { data } = await sb.auth.getSession();
        const token = data.session?.access_token;
        if (cancelled || !thread) return;
        const qs = token ? `?access_token=${encodeURIComponent(token)}` : '';
        const url = `/api/modules/ai/admin/threads/${thread.id}/stream${qs}`;
        es = new EventSource(url, { withCredentials: true });
        attachStreamHandlers(es);
      } catch (err) {
        console.warn('[ai-chat] SSE open failed', err);
      }
    })();
    function attachStreamHandlers(source: EventSource): void {
      source.onmessage = (ev) => {
        let parsed: { type?: string; delta?: string; recipeId?: string; tool?: string; query?: string; url?: string };
        try {
          parsed = JSON.parse(ev.data) as typeof parsed;
        } catch {
          return;
        }
        if (parsed.type === 'token') {
          if (typeof parsed.delta === 'string') {
            setLiveContent((prev) => prev + parsed.delta);
          }
        } else if (parsed.type === 'run.start') {
          pushLiveEvent(parsed.recipeId ? `running ${parsed.recipeId}` : 'starting');
        } else if (parsed.type === 'assistant.complete'
                || parsed.type === 'run.complete'
                || parsed.type === 'run.failed'
                || parsed.type === 'close') {
          // Worker reached a terminal state; the next poll has the
          // canonical row, so drop the SSE connection here.
          source.close();
        } else if (parsed.type?.startsWith('tool.')) {
          // Any sub-recipe tool call. Common cases get a friendly
          // verb ("searching" / "fetching"); everything else falls
          // through to the bare tool name so operators still see
          // *something* happening rather than a blank spinner.
          const toolName = parsed.type.slice('tool.'.length);
          if (toolName === 'web_search' || toolName === 'gatewaze_search') {
            pushLiveEvent(parsed.query ? `searching: ${parsed.query}` : 'searching the web');
          } else if (toolName === 'fetch_url' || toolName === 'gatewaze_fetch') {
            pushLiveEvent(parsed.url ? `fetching: ${parsed.url}` : 'fetching a url');
          } else {
            pushLiveEvent(`running ${toolName}`);
          }
        }
      };
      source.onerror = () => {
        // SSE will auto-reconnect; nothing to do.
      };
    }
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [thread?.id, hasRunningMessage]);

  // Auto-scroll to bottom on any new content. We capture the
  // pre-update "stuck to bottom" state synchronously via a layout
  // effect, then schedule the scroll for the next tick so it lands
  // after React has painted the new bubble. Threshold of 80px gives
  // the operator a small grace window if they scrolled up to read
  // something — they stay put unless they're effectively at the end.
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 80) {
      // requestAnimationFrame to let the new bubble lay out first.
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }, [messages, liveEvents, liveContent, queuedMessages]);

  // ── Build the assistant-ui external store adapter ──────────────────
  const isRunning = useMemo(
    () => messages.some((m) => m.status === 'running'),
    [messages],
  );

  // POST one message now. Used both for immediate sends (idle thread)
  // and for draining the queue. Returns when the turn has been
  // enqueued server-side + the optimistic refresh has landed.
  const sendMessageNow = async (text: string): Promise<void> => {
    if (!thread) return;
    setSending(true);
    try {
      await postMessage({
        threadId: thread.id,
        message: text,
        provider,
        model,
        ...(recipeOverride ? { recipeOverridePath: recipeOverride } : {}),
      });
      // Optimistic refresh; the polling effect will pull the
      // completed assistant turn.
      const result = await getThread(thread.id);
      setThread(result.thread);
      setMessages(result.messages);
    } catch (err) {
      console.error('[ai-chat] send failed', err);
      toast.error(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setSending(false);
    }
  };

  const cancelActiveRun = async (): Promise<void> => {
    if (!thread) return;
    const last = [...messages].reverse().find((m) => m.status === 'running');
    if (!last) return;
    try {
      await cancelMessage(thread.id, last.id);
      const result = await getThread(thread.id);
      setMessages(result.messages);
    } catch (err) {
      console.error('[ai-chat] cancel failed', err);
    }
  };

  const runtime = useExternalStoreRuntime<AiMessage>({
    messages,
    // Report NOT-running to assistant-ui so its composer stays
    // enabled while a turn is in flight — that's what lets the
    // operator type + submit follow-ups Claude-Code-style. We render
    // our own spinner / live-events / cancel UI from the derived
    // `isRunning` below, so we don't need assistant-ui's running
    // affordances.
    isRunning: false,
    convertMessage,
    onNew: async (message) => {
      if (!thread) return;
      const text = extractText(message);
      if (!text.trim()) return;
      // If a run is in flight (or one is sending, or a queue already
      // exists), park the message and let the drain effect send it
      // when the thread frees up — preserves submit order.
      if (isRunning || sending || queuedMessages.length > 0) {
        setQueuedMessages((prev) => [...prev, text]);
        return;
      }
      await sendMessageNow(text);
    },
    onCancel: cancelActiveRun,
  });

  // Drain the queue one message at a time once the thread is idle.
  // The lock ref guards the async window between popping and
  // `sending` flipping true; isRunning gates against the next turn
  // already being in flight.
  useEffect(() => {
    if (drainLockRef.current) return;
    if (isRunning || sending) return;
    if (queuedMessages.length === 0) return;
    drainLockRef.current = true;
    const [next, ...rest] = queuedMessages;
    setQueuedMessages(rest);
    void sendMessageNow(next!).finally(() => {
      drainLockRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, sending, queuedMessages]);

  async function handleReset() {
    if (!thread) return;
    if (!window.confirm('Reset the chat? All messages are lost.')) return;
    try {
      await deleteThread(thread.id);
      const fresh = await createThread({ useCase, hostKind, hostId, threadKey });
      setThread(fresh);
      setMessages([]);
    } catch (err) {
      console.error('[ai-chat] reset failed', err);
      toast.error('Reset failed');
    }
  }

  if (loading) {
    return (
      <div className="text-sm text-neutral-500 px-3 py-4 inline-flex items-center gap-2">
        <ArrowPathIcon className="size-4 animate-spin" />
        Loading chat…
      </div>
    );
  }

  // When embedded, drop the widget's own border/rounded chrome AND the
  // redundant "AI" header — the wrapper (e.g. AiChatModelTabs) already
  // identifies the chat via its tab strip + Run buttons, so the bar is
  // dead space. The wrapper also decides height: embedded widgets use
  // `flex-1 min-h-0` so they fill whatever vertical room the host gives
  // them, while standalone widgets keep the legacy max-h-[480px] cap.
  const rootClass = embedded
    ? 'flex flex-col bg-white flex-1 min-h-0'
    : 'rounded-md border bg-neutral-50/60 flex flex-col';
  const headerClass = 'flex items-center justify-between px-3 py-2 border-b bg-white rounded-t-md';
  const composerClass = embedded
    ? 'px-3 py-2 border-t bg-white flex items-center gap-2'
    : 'px-3 py-2 border-t bg-white rounded-b-md flex items-center gap-2';
  const messagesClass = embedded
    ? 'px-3 py-3 space-y-3 flex-1 min-h-0 overflow-y-auto'
    : 'px-3 py-3 space-y-3 max-h-[480px] overflow-y-auto';

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className={rootClass}>
        {!embedded && (
          <header className={headerClass}>
            <div className="flex items-center gap-2 text-sm font-medium">
              <SparklesIcon className="size-4 text-amber-600" />
              <span>AI</span>
              {modelPicker && (
                <ModelPicker
                  provider={provider}
                  model={model ?? defaultModel}
                  models={models}
                  onChange={(p, m) => {
                    setProvider(p);
                    setModel(m);
                  }}
                />
              )}
              {thread && thread.cost_micro_usd > 0 && (
                <span className="text-xs text-neutral-500 ml-2">
                  {microUsdToDollars(thread.cost_micro_usd)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {isRunning && (
                <button
                  type="button"
                  onClick={() => void cancelActiveRun()}
                  className="text-xs text-neutral-600 hover:text-neutral-900 px-2"
                  title="Cancel"
                >
                  <XMarkIcon className="size-4" />
                </button>
              )}
              {messages.length > 0 && (
                <button
                  type="button"
                  onClick={handleReset}
                  className="text-xs text-red-600 hover:text-red-900 px-2"
                  title="Reset thread"
                >
                  <TrashIcon className="size-4" />
                </button>
              )}
            </div>
          </header>
        )}

        <div className="flex flex-col flex-1 min-h-0">
          {/* Pre-run provenance — same shape as the post-run RunDetails
              panel under each assistant message. Surfaces which
              skill/prompt will run before the operator clicks Send. */}
          <ConfiguredPromptBar
            useCase={useCase}
            recipeOverride={recipeOverride}
            onRecipeOverrideChange={onRecipeOverrideChange}
          />
          <div className={messagesClass} ref={messagesScrollRef}>
            {messages.map((m) => {
              if (m.role === 'user') {
                return (
                  <div key={m.id} className="flex justify-end">
                    {/* Use Radix Themes' accent token so the user bubble
                        tracks the workspace's primary color rather than
                        a hardcoded blue. var(--accent-9) is the same
                        primary the Send button uses elsewhere. */}
                    <div
                      className="max-w-[80%] rounded-2xl rounded-br-sm text-white px-3 py-2 text-sm whitespace-pre-wrap"
                      style={{ backgroundColor: 'var(--accent-9)' }}
                    >
                      {m.content}
                    </div>
                  </div>
                );
              }
              // Historical tool-call bubbles from structured.live_events
              // (persisted by the worker at run-completion time so a
               // page reload still shows the full step history). Same
              // muted styling the live spinner uses for in-progress
              // events — operators can scroll back through the agent's
              // searches/fetches even after the run is done. Render
              // ONLY for messages NOT currently running, because the
              // isRunning section below already renders these from the
              // in-memory liveEvents state.
              const persistedEvents =
                m.role === 'assistant' && m.status === 'complete'
                  ? extractPersistedLiveEvents(m.structured)
                  : [];
              const historyBubbles = persistedEvents.length > 0 ? (
                <div className="space-y-1 mb-2">
                  {persistedEvents.map((ev, i) => (
                    <div
                      key={`${m.id}-h-${i}`}
                      className="rounded-2xl rounded-bl-sm bg-neutral-100 px-3 py-1.5 text-xs text-neutral-500 block w-fit"
                    >
                      {ev.text}
                    </div>
                  ))}
                </div>
              ) : null;
              // Let the host render ANY assistant turn (not only structured
              // ones) — it returns null to fall back to the default bubble.
              // Hosts that render Markdown/HTML need this for plain-text turns.
              const structuredJsx =
                m.role === 'assistant' && renderAssistantTurn
                  ? renderAssistantTurn(m)
                  : null;
              if (structuredJsx) {
                return (
                  <div key={m.id} className="flex justify-start">
                    <div className="max-w-[90%] w-full">
                      {historyBubbles}
                      {structuredJsx}
                      <RunDetails message={m} />
                    </div>
                  </div>
                );
              }
              // Skip empty assistant placeholders while still running —
              // the isRunning block below renders the live spinner /
              // streamed content. Empty + complete still renders (lets
              // empty-final-output be visually distinct).
              if (
                m.role === 'assistant' &&
                m.status !== 'complete' &&
                m.content.length === 0
              ) {
                return null;
              }
              return (
                <div key={m.id} className="flex justify-start">
                  <div className="max-w-[90%]">
                    {historyBubbles}
                    <div className="rounded-2xl rounded-bl-sm bg-neutral-100 px-3 py-2 text-sm text-neutral-800 whitespace-pre-wrap">
                      {m.content}
                    </div>
                    {m.role === 'assistant' && <RunDetails message={m} />}
                  </div>
                </div>
              );
            })}
            {isRunning && (
              <div className="flex justify-start">
                <div className="max-w-[90%] w-full space-y-1">
                  {liveContent.length > 0 && (
                    <div className="rounded-2xl rounded-bl-sm bg-neutral-100 px-3 py-2 text-sm text-neutral-800 whitespace-pre-wrap">
                      {liveContent}
                    </div>
                  )}
                  {/*
                    Each completed action gets its own bubble — no spinner;
                    these are historical "we did this" markers. The newest
                    action gets the spinner bubble below to indicate
                    "currently working on this".
                  */}
                  {liveEvents.slice(0, -1).map((ev) => (
                    <div
                      key={ev.id}
                      className="rounded-2xl rounded-bl-sm bg-neutral-100 px-3 py-1.5 text-xs text-neutral-500 block w-fit"
                    >
                      {ev.text}
                    </div>
                  ))}
                  <div className="rounded-2xl rounded-bl-sm bg-neutral-100 px-3 py-2 text-sm text-neutral-600 flex w-fit items-center gap-2">
                    <ArrowPathIcon className="size-4 animate-spin" />
                    {liveEvents.length > 0
                      ? liveEvents[liveEvents.length - 1]!.text
                      : (liveContent.length > 0 ? 'streaming…' : 'Thinking…')}
                  </div>
                </div>
              </div>
            )}
            {/* Queued follow-ups the operator submitted while a turn was
                in flight. Rendered as dimmed right-aligned user bubbles
                with a "queued" tag so they can see what's pending; they
                send automatically in order once the thread frees up. */}
            {queuedMessages.map((q, i) => (
              <div key={`queued-${i}`} className="flex justify-end">
                <div
                  className="max-w-[80%] rounded-2xl rounded-br-sm text-white px-3 py-2 text-sm whitespace-pre-wrap opacity-50"
                  style={{ backgroundColor: 'var(--accent-9)' }}
                >
                  {q}
                  <span className="ml-2 text-[10px] uppercase tracking-wide opacity-80">queued</span>
                </div>
              </div>
            ))}
          </div>

          {readOnly ? (
            <div className="px-3 py-2 text-xs text-neutral-400 border-t">
              Read-only — this tab shows the model's drafts from the generation run.
            </div>
          ) : (
            <ComposerPrimitive.Root className={composerClass}>
              <ComposerPrimitive.Input
                placeholder={isRunning ? 'Working… (your message will queue)' : 'Type a message…'}
                className="form-input flex-1 text-sm"
              />
              <ComposerPrimitive.Send
                className="inline-flex items-center px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm disabled:opacity-50"
              >
                <PaperAirplaneIcon className="size-4 mr-1" />
                {isRunning ? 'Queue' : 'Send'}
              </ComposerPrimitive.Send>
            </ComposerPrimitive.Root>
          )}
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}

/**
 * Translate one of our AiMessage rows into the ThreadMessageLike shape
 * assistant-ui's external-store runtime consumes for state tracking.
 *
 * Note: we don't use assistant-ui's `ThreadPrimitive.Messages` renderer —
 * the message list is rendered directly in the component above. Tried
 * smuggling structured-output JSX through a custom `type: 'ui'` content
 * part; assistant-ui validates against a fixed part schema and throws
 * "Unsupported assistant message part type: ui". So this converter only
 * needs to emit a valid text part to keep the runtime's state happy
 * (running detection, send/cancel wiring) — host-rendered structured
 * cards happen outside this path.
 */
/**
 * Read the persisted tool-call history off a completed assistant
 * message's `structured` payload. The worker writes one entry per
 * "searching: ..." / "fetching: ..." / "running ..." event during
 * the run so reload-after-completion still surfaces the full step
 * trail. Defensive about shape because `structured` is JSONB and
 * may be anything (or a legacy shape without live_events).
 */
function extractPersistedLiveEvents(
  structured: Record<string, unknown> | null | undefined,
): Array<{ text: string }> {
  if (!structured || typeof structured !== 'object') return [];
  const list = (structured as { live_events?: unknown }).live_events;
  if (!Array.isArray(list)) return [];
  const out: Array<{ text: string }> = [];
  for (const ev of list) {
    if (ev && typeof ev === 'object' && typeof (ev as { text?: unknown }).text === 'string') {
      out.push({ text: (ev as { text: string }).text });
    }
  }
  return out;
}

function convertMessage(m: AiMessage): ThreadMessageLike {
  const role = m.role === 'tool_summary' ? 'assistant' : (m.role as 'user' | 'assistant' | 'system');
  return {
    role,
    id: m.id,
    createdAt: new Date(m.created_at),
    content: [{ type: 'text', text: m.content || '' }],
  };
}

function extractText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n');
}

// ─── Model picker ──────────────────────────────────────────────────────────

function ModelPicker({
  provider,
  model,
  models,
  onChange,
}: {
  provider: AiAutoOrProvider;
  model: string | undefined;
  models: AiModelInfo[];
  onChange: (provider: AiAutoOrProvider, model: string | undefined) => void;
}) {
  if (models.length === 0) return null;
  const value = provider === 'auto' ? 'auto' : `${provider}:${model ?? models[0].model}`;
  return (
    <select
      className="text-xs border border-neutral-200 rounded px-1 py-0.5 bg-white"
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        if (v === 'auto') {
          onChange('auto', undefined);
          return;
        }
        const [p, m] = v.split(':') as [AiProvider, string];
        onChange(p, m);
      }}
    >
      <option value="auto">auto</option>
      {models.map((m) => (
        <option key={`${m.provider}:${m.model}`} value={`${m.provider}:${m.model}`}>
          {m.label || `${m.provider}/${m.model}`}
        </option>
      ))}
    </select>
  );
}
