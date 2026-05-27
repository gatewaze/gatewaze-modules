/**
 * AiChatModelTabs — multi-model chat wrapper around AiChatWidget.
 *
 * Lets the operator open one chat tab per model so they can compare
 * outputs side-by-side against the SAME prompt. Each tab is a
 * fully-isolated thread (BullMQ-keyed by `thread_key=<modelId>` against
 * the ai_threads `(use_case, host_kind, host_id, thread_key)` unique
 * constraint), so model switches don't pollute each other's history.
 *
 * Architecture:
 *   - Internal state: `openTabs: ModelId[]` + `activeTab: ModelId`.
 *   - One <AiChatWidget> is mounted per open tab (each with its own
 *     threadKey + defaultModel). All stay mounted regardless of
 *     visibility — we use display:none on inactive tabs — so their
 *     polling stays alive and a model running in the background can
 *     finish while the operator stares at a different tab.
 *   - "Run research" fires the use case's kickoff_message against the
 *     ACTIVE tab's thread.
 *   - "Run on all tabs" fires the same message against every open
 *     tab's thread in parallel; the operator can then flip between
 *     tabs as each model produces output.
 *
 * If the operator wants to send something different per model, they
 * just type it into the active tab's composer — the per-tab widget
 * already supports free-form messages.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowPathIcon,
  SparklesIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';

import AiChatWidget, { type AiChatWidgetProps } from './AiChatWidget';
import {
  createThread,
  listThreadsByHost,
  listUseCaseModels,
  listUseCases,
  lookupThread,
  postMessage,
  type AiMessage,
  type AiModelInfo,
  type AiUseCase,
} from '../utils/aiService';

export interface AiChatModelTabsProps
  extends Omit<AiChatWidgetProps, 'threadKey' | 'modelPicker'> {
  /**
   * Hard-coded list of models to open as tabs on mount. Each must be a
   * model id (e.g. 'claude-sonnet-4-5'). If omitted, the wrapper opens
   * a single tab for `defaultModel` and exposes the model picker to
   * add more.
   */
  initialModels?: string[];
  /**
   * Notified whenever the set of open tabs changes (add, close,
   * reorder). Hosts use this to fan their own actions out across the
   * same models the operator has chosen — e.g. daily-briefing's
   * "Run autopilot" uses this list to dispatch one structured-output
   * kickoff per tab.
   */
  onOpenTabsChange?: (modelIds: string[]) => void;
  /**
   * Override the default chat-path kickoff (which sends the use case's
   * `kickoff_message` via postMessage). Hosts that need a structured-
   * output flow — like daily-briefing's submit_candidates tool — supply
   * a callback that POSTs to their own endpoint instead. The callback
   * receives the list of model ids to fan out across:
   *   - "Run research" button → passes [activeTabModel]
   *   - "Run on all tabs" button → passes every open tab's model
   * When unset, the wrapper falls back to the generic postMessage path.
   */
  customKickoff?: (models: string[]) => Promise<void>;
}

interface TabState {
  modelId: string;
}

export default function AiChatModelTabs(props: AiChatModelTabsProps) {
  const {
    useCase,
    hostKind,
    hostId,
    defaultProvider = 'anthropic',
    defaultModel,
    initialModels,
    onOpenTabsChange,
    customKickoff,
    renderAssistantTurn,
    onAssistantMessage,
  } = props;

  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [useCaseRow, setUseCaseRow] = useState<AiUseCase | null>(null);
  // openTabs preserves insertion order — left-to-right tab strip.
  const [openTabs, setOpenTabs] = useState<TabState[]>(() => {
    const seed = initialModels && initialModels.length > 0
      ? initialModels
      : defaultModel
        ? [defaultModel]
        : [];
    return seed.map((modelId) => ({ modelId }));
  });
  const [activeTabId, setActiveTabId] = useState<string | null>(
    openTabs[0]?.modelId ?? null,
  );
  const [runningActive, setRunningActive] = useState(false);
  // Per-tab sub-recipe override. Lives here (not in the child widget)
  // so both fireMessageOnTab / runResearchOnActiveTab can read the
  // active tab's selection, and the widget can render the picker.
  const [recipeOverrideByTab, setRecipeOverrideByTab] = useState<Record<string, string | null>>({});

  // ── Hydrate openTabs from existing threads ──────────────────────────
  // Every prior conversation for this (useCase, hostKind, hostId) lives
  // in `ai_threads` keyed by `thread_key=<modelId>`. On mount, fetch
  // them and add any model that already has a thread to the open-tab
  // set. This is what makes the operator's tabs survive a page refresh
  // (and a refresh mid-autopilot keeps the in-flight runs visible
  // because each model's thread is its own row).
  //
  // After mount, KEEP polling on a short cadence so threads created
  // server-side after the widget loaded (e.g. a kickoff that pre-
  // creates per-sub-recipe threads) auto-open as tabs. Cadence
  // matches the inner widget's poll (4s) — short enough for the
  // operator to feel immediate, light enough that idle dashboards
  // don't hammer the API.
  useEffect(() => {
    let cancelled = false;
    async function discover(): Promise<void> {
      try {
        const threads = await listThreadsByHost({ useCase, hostKind, hostId });
        if (cancelled) return;
        const keysWithThreads = threads
          .map((t) => t.thread_key)
          .filter((k): k is string => typeof k === 'string' && k.length > 0);
        if (keysWithThreads.length === 0) return;
        setOpenTabs((prev) => {
          const have = new Set(prev.map((t) => t.modelId));
          const merged = [...prev];
          let changed = false;
          for (const k of keysWithThreads) {
            if (!have.has(k)) {
              merged.push({ modelId: k });
              have.add(k);
              changed = true;
            }
          }
          return changed ? merged : prev;
        });
      } catch (err) {
        console.warn('[ai-chat-tabs] thread discovery failed', err);
      }
    }
    void discover();
    const id = setInterval(() => void discover(), 4_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [useCase, hostKind, hostId]);

  // ── Load available models + the use case row (for kickoff_message). ─
  useEffect(() => {
    listUseCaseModels(useCase).then(setModels).catch((err) => {
      console.warn('[ai-chat-tabs] failed to load models', err);
    });
  }, [useCase]);

  useEffect(() => {
    listUseCases()
      .then((rows) => {
        const found = rows.find((r) => r.id === useCase);
        if (found) setUseCaseRow(found);
      })
      .catch((err) => console.warn('[ai-chat-tabs] failed to load use case', err));
  }, [useCase]);

  // Once the use case row loads, seed a default tab IF the operator
  // hasn't already supplied one (no initialModels, no defaultModel prop,
  // and no existing thread was hydrated from the server). This lets the
  // host stop hardcoding `defaultModel` and instead defer to whatever
  // the operator picked in AI > Use Cases.
  useEffect(() => {
    if (!useCaseRow?.default_model) return;
    setOpenTabs((prev) => {
      if (prev.length > 0) return prev;
      return [{ modelId: useCaseRow.default_model as string }];
    });
  }, [useCaseRow?.default_model]);

  // If activeTabId got removed (e.g. tab closed), drop to whatever's left.
  useEffect(() => {
    if (activeTabId && openTabs.some((t) => t.modelId === activeTabId)) return;
    setActiveTabId(openTabs[0]?.modelId ?? null);
  }, [openTabs, activeTabId]);

  // Publish openTabs to the host so it can fan actions over the same
  // set of models. Stringify keys for the deps array — we only care
  // about the model-id sequence, not object identity.
  useEffect(() => {
    onOpenTabsChange?.(openTabs.map((t) => t.modelId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTabs.map((t) => t.modelId).join('|')]);

  // Models grouped by provider — drives the "add model tab" dropdown.
  const modelsByProvider = useMemo(() => {
    const out = new Map<string, AiModelInfo[]>();
    for (const m of models) {
      const arr = out.get(m.provider) ?? [];
      arr.push(m);
      out.set(m.provider, arr);
    }
    return out;
  }, [models]);

  const closedModels = useMemo(() => {
    const open = new Set(openTabs.map((t) => t.modelId));
    return models.filter((m) => !open.has(m.model));
  }, [models, openTabs]);

  // The "kickoff" can come from one of three places, in priority order:
  //   1. An explicit `kickoff_message` on the use case row.
  //   2. A bound skill (skill_source_id + skill_path) — the skill body
  //      drives the system prompt; we send a minimal user message so
  //      the model has something to respond to.
  //   3. Nothing — disable Run buttons + show "No kickoff configured".
  const explicitKickoff = useCaseRow?.kickoff_message?.trim() ?? '';
  const hasBoundSkill = Boolean(
    useCaseRow?.skill_source_id && useCaseRow?.skill_path,
  );
  const kickoffMessage = explicitKickoff
    ? explicitKickoff
    : hasBoundSkill
      ? 'Start.'
      : '';

  function modelLabel(modelId: string): string {
    const info = models.find((m) => m.model === modelId);
    return info?.label || info?.model || modelId;
  }

  function addTab(modelId: string) {
    setOpenTabs((prev) => {
      if (prev.some((t) => t.modelId === modelId)) return prev;
      return [...prev, { modelId }];
    });
    setActiveTabId(modelId);
  }

  function closeTab(modelId: string) {
    setOpenTabs((prev) => prev.filter((t) => t.modelId !== modelId));
  }

  /**
   * Ensure an ai_threads row exists for (useCase, hostKind, hostId,
   * threadKey=modelId), then POST the given message. The per-tab
   * AiChatWidget picks up the new turn via its existing polling.
   */
  async function fireMessageOnTab(modelId: string, message: string): Promise<void> {
    const threadKey = modelId;
    const existing = await lookupThread({ useCase, hostKind, hostId, threadKey });
    const t = existing ?? (await createThread({ useCase, hostKind, hostId, threadKey }));
    const override = recipeOverrideByTab[modelId] ?? null;
    // Provider is inferred by the runner from the model; pass model
    // explicitly so the router picks THIS one rather than the
    // use-case's default_provider walk. Forward this tab's recipe
    // override too so the worker runs the picked sub-recipe instead
    // of the chat handler's auto first-sub-recipe default.
    await postMessage({
      threadId: t.id,
      message,
      model: modelId,
      provider: 'auto',
      ...(override ? { recipeOverridePath: override } : {}),
    });
  }

  async function runOnActive() {
    if (!activeTabId) return;
    if (!customKickoff && !kickoffMessage) {
      toast.error('This use case has no kickoff message configured');
      return;
    }
    setRunningActive(true);
    try {
      if (customKickoff) {
        await customKickoff([activeTabId]);
      } else {
        await fireMessageOnTab(activeTabId, kickoffMessage);
      }
    } catch (err) {
      console.error('[ai-chat-tabs] run active failed', err);
      toast.error(err instanceof Error ? err.message : 'Run failed');
    } finally {
      setRunningActive(false);
    }
  }

  /**
   * Send a "do the research" chat message to the active tab's model.
   * Routes through the chat path (run-chat-handler), which now uses
   * the bound recipe's first sub-recipe as its template (instructions
   * + response schema). End result: the active tab's model runs the
   * per-pass research job — same job sonnet / gpt-5 sub-recipes do
   * during a full Run research, but executed by THIS tab's model.
   *
   * Operators use this to test the research task on a new model
   * (e.g. Gemini 3 Pro) without authoring a dedicated sub-recipe.
   */
  const [runningTabResearch, setRunningTabResearch] = useState(false);
  async function runResearchOnActiveTab() {
    if (!activeTabId) return;
    const activeTab = openTabs.find((t) => t.modelId === activeTabId);
    const label = activeTab?.label ?? activeTabId;
    setRunningTabResearch(true);
    try {
      await fireMessageOnTab(
        activeTabId,
        'Run the research task as described in your instructions. Use your available web tools, follow the response schema exactly, and emit your candidates.',
      );
      toast.success(`Research dispatched to ${label}`);
    } catch (err) {
      console.error('[ai-chat-tabs] run research on active tab failed', err);
      toast.error(err instanceof Error ? err.message : 'Failed to dispatch');
    } finally {
      setRunningTabResearch(false);
    }
  }

  return (
    <div className="bg-white flex flex-col flex-1 min-h-0">
      {/* Tab strip + actions */}
      <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-b bg-neutral-50">
        <div className="flex items-center gap-1 overflow-x-auto">
          {openTabs.map((tab) => {
            const isActive = tab.modelId === activeTabId;
            return (
              <button
                key={tab.modelId}
                type="button"
                onClick={() => setActiveTabId(tab.modelId)}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs whitespace-nowrap ${
                  isActive
                    ? 'bg-white border border-neutral-300 text-neutral-900 shadow-sm'
                    : 'text-neutral-600 hover:bg-neutral-100'
                }`}
              >
                <span>{modelLabel(tab.modelId)}</span>
                {openTabs.length > 1 && (
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.modelId);
                    }}
                    className="ml-1 text-neutral-400 hover:text-red-600"
                    title="Close tab"
                  >
                    <XMarkIcon className="size-3" />
                  </span>
                )}
              </button>
            );
          })}
          {closedModels.length > 0 && (
            <AddTabDropdown
              modelsByProvider={modelsByProvider}
              closed={closedModels}
              onPick={addTab}
            />
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {(customKickoff || kickoffMessage) ? (
            <>
              {/* Per-tab research kickoff. Bypasses customKickoff
                  (which runs the parent recipe with its declared sub-
                  recipe models) and instead sends a "do the research"
                  chat message to the active tab. The chat handler
                  resolves the bound recipe's first sub-recipe template
                  and runs THAT job on the active tab's model — works
                  for any model in the picker (Gemini, Haiku, etc.).
                  Hidden until the operator opens a second tab: with
                  only the default Haiku tab visible on first load,
                  "Run on Haiku" is redundant with "Run research"
                  (the latter already kicks off the parent recipe
                  whose first sub-recipe pass is haiku-equivalent). */}
              {activeTabId && openTabs.length > 1 && (
                <button
                  type="button"
                  onClick={() => void runResearchOnActiveTab()}
                  disabled={runningTabResearch}
                  className="inline-flex items-center px-2 py-1 rounded text-xs border border-amber-600 text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                  title={`Run the research task on this tab's model only (${openTabs.find((t) => t.modelId === activeTabId)?.label ?? activeTabId})`}
                >
                  {runningTabResearch ? (
                    <ArrowPathIcon className="size-3 mr-1 animate-spin" />
                  ) : (
                    <SparklesIcon className="size-3 mr-1" />
                  )}
                  Run on {openTabs.find((t) => t.modelId === activeTabId)?.label ?? activeTabId}
                </button>
              )}
              <button
                type="button"
                onClick={() => void runOnActive()}
                disabled={runningActive || !activeTabId}
                // border-transparent matches the outlined "Run on
                // <model>" button's 1px border so both buttons sit at
                // the same height; without it the solid Run-research
                // button reads as 2px shorter.
                className="inline-flex items-center px-2 py-1 rounded text-xs border border-transparent bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                title="Send the use case's kickoff message to the active tab"
              >
                {runningActive ? (
                  <ArrowPathIcon className="size-3 mr-1 animate-spin" />
                ) : (
                  <SparklesIcon className="size-3 mr-1" />
                )}
                Run research
              </button>
            </>
          ) : (
            <span
              className="text-xs text-neutral-400"
              title="Configure a Kickoff message OR bind a Skill on this use case (AI > Use Cases) to enable Run research."
            >
              No kickoff configured
            </span>
          )}
        </div>
      </div>

      {/* Body — all open tabs are mounted; only the active one is visible.
          display:none keeps each AiChatWidget's polling alive in the
          background so a long-running model continues toward completion
          while the operator looks at another tab. The body flex-fills
          so the embedded chat widget gets the host's full available
          height (DailyBriefingTab gives ~80vh per day section). */}
      <div className="flex-1 min-h-0 flex flex-col">
        {openTabs.map((tab) => {
          const isActive = tab.modelId === activeTabId;
          // Active tab participates in the flex layout; inactive tabs
          // are display:none so their widget keeps polling but doesn't
          // grab layout space.
          return (
            <div
              key={tab.modelId}
              className={isActive ? 'flex flex-col flex-1 min-h-0' : ''}
              style={{ display: isActive ? 'flex' : 'none' }}
            >
              <AiChatWidget
                useCase={useCase}
                hostKind={hostKind}
                hostId={hostId}
                threadKey={tab.modelId}
                // Infer provider per-tab from the model id. Each tab
                // pins a specific model (Claude Haiku, Claude Sonnet,
                // GPT-5, ...); the provider follows the model. Using a
                // shared defaultProvider here sent the GPT-5 tab's
                // chat turns to Anthropic, which 404'd on model=gpt-5.
                defaultProvider={inferProviderFromModelId(tab.modelId) ?? defaultProvider}
                defaultModel={tab.modelId}
                modelPicker={false}
                embedded
                renderAssistantTurn={renderAssistantTurn}
                onAssistantMessage={onAssistantMessage}
                recipeOverride={recipeOverrideByTab[tab.modelId] ?? null}
                onRecipeOverrideChange={(path) =>
                  setRecipeOverrideByTab((prev) => ({ ...prev, [tab.modelId]: path }))
                }
              />
            </div>
          );
        })}
        {openTabs.length === 0 && (
          <div className="px-3 py-6 text-sm text-neutral-500 text-center">
            No model tabs open. Use the <strong>+</strong> button above to add one.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Add-tab dropdown ──────────────────────────────────────────────────

function AddTabDropdown({
  modelsByProvider,
  closed,
  onPick,
}: {
  modelsByProvider: Map<string, AiModelInfo[]>;
  closed: AiModelInfo[];
  onPick: (modelId: string) => void;
}) {
  void modelsByProvider;
  return (
    <select
      className="text-xs border border-neutral-200 rounded px-1 py-0.5 bg-white text-neutral-600 ml-1"
      defaultValue=""
      onChange={(e) => {
        const v = e.target.value;
        if (!v) return;
        onPick(v);
        // Reset so picking the same model again would still re-add (only relevant after a close).
        e.currentTarget.value = '';
      }}
      title="Open another model in a new tab"
    >
      <option value="" disabled>
        + Add tab…
      </option>
      {closed.map((m) => (
        <option key={m.model} value={m.model}>
          {(m.label || m.model)} ({m.provider})
        </option>
      ))}
    </select>
  );
}

/**
 * Map a model id back to the provider that serves it. Mirrors the
 * runner-side inferProviderFromModel in lib/recipes/run-recipe-goose.ts.
 * Returns null when the model id doesn't match a known prefix so the
 * caller can fall through to whatever defaultProvider was supplied.
 */
function inferProviderFromModelId(model: string): 'anthropic' | 'openai' | 'gemini' | null {
  if (model.startsWith('claude') || model.includes('haiku') || model.includes('sonnet') || model.includes('opus')) {
    return 'anthropic';
  }
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) {
    return 'openai';
  }
  if (model.startsWith('gemini')) return 'gemini';
  return null;
}

// Re-export the message type so consumers can declare onAssistantMessage typed.
export type { AiMessage };
