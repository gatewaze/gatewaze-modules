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
  ThreadPrimitive,
  MessagePrimitive,
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
  } = props;

  const [thread, setThread] = useState<AiThread | null>(null);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [provider, setProvider] = useState<AiAutoOrProvider>(defaultProvider);
  const [model, setModel] = useState<string | undefined>(defaultModel);
  const [models, setModels] = useState<AiModelInfo[]>([]);

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

  // ── Poll while an assistant message is running ─────────────────────
  const runningStartedAt = useRef<number | null>(null);
  useEffect(() => {
    const hasRunning = messages.some((m) => m.status === 'running');
    if (!hasRunning) {
      runningStartedAt.current = null;
      return;
    }
    if (runningStartedAt.current == null) runningStartedAt.current = Date.now();
    const elapsed = Date.now() - runningStartedAt.current;
    const interval =
      elapsed > POLL_LONG_BACKOFF_AT_MS
        ? POLL_INTERVAL_MS * 4
        : elapsed > POLL_BACKOFF_AT_MS
          ? POLL_INTERVAL_MS * 2
          : POLL_INTERVAL_MS;

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

  // ── Build the assistant-ui external store adapter ──────────────────
  const isRunning = useMemo(
    () => messages.some((m) => m.status === 'running'),
    [messages],
  );

  const runtime = useExternalStoreRuntime<AiMessage>({
    messages,
    isRunning: isRunning || sending,
    convertMessage: convertMessage(renderAssistantTurn),
    onNew: async (message) => {
      if (!thread) return;
      const text = extractText(message);
      if (!text.trim()) return;
      setSending(true);
      try {
        await postMessage({ threadId: thread.id, message: text, provider, model });
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
    },
    onCancel: async () => {
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
    },
  });

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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="rounded-md border bg-neutral-50/60 flex flex-col">
        <header className="flex items-center justify-between px-3 py-2 border-b bg-white rounded-t-md">
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
                onClick={() => void runtime.thread.cancelRun?.()}
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

        <ThreadPrimitive.Root className="flex flex-col">
          <ThreadPrimitive.Viewport className="px-3 py-3 space-y-3 max-h-[480px] overflow-y-auto">
            <ThreadPrimitive.Messages
              components={{
                UserMessage: () => (
                  <MessagePrimitive.Root className="flex justify-end">
                    <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-blue-600 text-white px-3 py-2 text-sm whitespace-pre-wrap">
                      <MessagePrimitive.Content />
                    </div>
                  </MessagePrimitive.Root>
                ),
                AssistantMessage: () => (
                  <MessagePrimitive.Root className="flex justify-start">
                    <div className="max-w-[90%] rounded-2xl rounded-bl-sm bg-white border px-3 py-2 text-sm text-neutral-800 whitespace-pre-wrap">
                      <MessagePrimitive.Content />
                    </div>
                  </MessagePrimitive.Root>
                ),
              }}
            />
            {isRunning && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-sm bg-white border px-3 py-2 text-sm text-neutral-600 inline-flex items-center gap-2">
                  <ArrowPathIcon className="size-4 animate-spin" />
                  Thinking…
                </div>
              </div>
            )}
          </ThreadPrimitive.Viewport>

          <ComposerPrimitive.Root className="px-3 py-2 border-t bg-white rounded-b-md flex items-center gap-2">
            <ComposerPrimitive.Input
              placeholder={isRunning ? 'Working…' : 'Type a message…'}
              className="form-input flex-1 text-sm"
              disabled={isRunning || sending}
            />
            <ComposerPrimitive.Send
              className="inline-flex items-center px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm disabled:opacity-50"
              disabled={isRunning || sending}
            >
              <PaperAirplaneIcon className="size-4 mr-1" />
              Send
            </ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
}

/**
 * Translate one of our AiMessage rows into the ThreadMessageLike shape
 * assistant-ui consumes. Structured-output turns get rendered via the
 * host-supplied `renderAssistantTurn` callback (returns JSX → wrapped
 * in a custom content part); plain narrative turns get a single text
 * content part.
 */
function convertMessage(
  renderAssistantTurn: AiChatWidgetProps['renderAssistantTurn'],
) {
  return (m: AiMessage): ThreadMessageLike => {
    // The library expects role ∈ 'user' | 'assistant' | 'system'.
    // tool_summary maps to 'assistant' for v1 (rare, used by some
    // future use-cases that summarise tool output as a separate turn).
    const role = m.role === 'tool_summary' ? 'assistant' : (m.role as 'user' | 'assistant' | 'system');

    // Structured-output rendering: let the host module substitute the
    // entire content. We use a custom "ui" part — assistant-ui passes
    // it through unchanged so the consumer can render arbitrary JSX.
    if (role === 'assistant' && m.structured && renderAssistantTurn) {
      const ui = renderAssistantTurn(m);
      if (ui) {
        return {
          role,
          id: m.id,
          createdAt: new Date(m.created_at),
          content: [
            // Falls back to the narrative text if assistant-ui renders
            // this in a context that doesn't honour the ui part.
            { type: 'text', text: m.content || '' },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ({ type: 'ui', display: ui } as any),
          ],
        };
      }
    }

    return {
      role,
      id: m.id,
      createdAt: new Date(m.created_at),
      content: [{ type: 'text', text: m.content || '' }],
    };
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
