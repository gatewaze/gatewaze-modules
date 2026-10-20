/**
 * The Research panel for a research block, shown beneath Puck's fields in the
 * block sidebar (spec-content-discovery-and-research-blocks.md §5.2–§5.4).
 *
 * What it shows: the binding (input, transform, schedule), the latest run,
 * the run history with "Revert to this run", and the block's resolved output
 * — grouped items for array outputs, research vs edited text for scalar and
 * richtext outputs — with the author's edit controls.
 *
 * What it writes: ONLY `content.research_edits`, through the
 * `newsletters_research_edits_write(p_block_id, p_edits, p_expected_version)`
 * RPC, with the edition's current version. The research layer itself
 * (`content.<output.field>`) is never touched here: runs write it, and the
 * Run / Cancel / Revert buttons go through the research routes. A
 * version_conflict from the RPC is handled like the editor's other saves:
 * the host reconciles research-only changes and the write is retried once.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  LinkIcon,
  MapPinIcon,
  PencilSquareIcon,
  PlusIcon,
  StopCircleIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { Badge, Button, ConfirmModal } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { AiChatModelTabs } from '@gatewaze-modules/ai/admin';
import type { EditionBlock } from '../utils/types.js';
import { researchBindingOf, researchOutputFormat, researchUseCaseOf } from '../lib/research-block.js';
import {
  asResearchEdits,
  resolveResearchArray,
  resolveResearchScalar,
  type ArrayEdits,
  type ResearchItem,
  type ResolvedGroup,
} from '../../lib/research-merge.js';
import { researchService, type EditionResearch, type ResearchRun } from '../utils/researchService.js';

export interface ResearchPanelProps {
  editionId: string;
  /**
   * Writes are refused unless the edition is a draft or published (and has
   * not started sending, which the server reports as `research_open`); the
   * panel disables them otherwise.
   */
  editionStatus?: string;
  block: EditionBlock;
  /** The edition version the editor currently holds (newsletters_editions.version). */
  getVersion: () => number;
  /** The RPC accepted the edit layer: the host stores it on the block and adopts the new version. */
  onEditsWritten: (blockId: string, edits: Record<string, unknown>, newVersion: number) => void;
  /**
   * The research layer changed on the server (a run completed, a revert, or
   * a version_conflict on an edit write). The host refetches and adopts the
   * research fields if nothing else changed; resolves true when it did.
   */
  onResearchChanged: () => Promise<boolean>;
}

const POLL_MS = 8000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');
const fmtCost = (micro: number | null | undefined) => (micro ? `$${(micro / 1_000_000).toFixed(4)}` : '$0');
const isConflict = (e: { code?: string; message?: string } | null) => !!e && (e.code === '55006' || /version_conflict/i.test(e.message ?? ''));

/** Key for a hand-added item: the normalised url (spec §5.1), so a later run returning the same post dedupes against it. */
function keyForUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url.trim();
  }
}

function statusColor(run: ResearchRun | null | undefined): 'green' | 'orange' | 'red' | 'gray' | 'blue' {
  switch (run?.status) {
    case 'complete': return 'green';
    case 'running': return 'blue';
    case 'queued': return 'orange';
    case 'failed': return 'red';
    default: return 'gray';
  }
}

export function ResearchPanel({ editionId, editionStatus, block, getVersion, onEditsWritten, onResearchChanged }: ResearchPanelProps): ReactElement | null {
  const binding = researchBindingOf(block.block_template);
  const hash = block.block_template.binding_hash ?? '';
  const statusOpen = ['draft', 'published'].includes(editionStatus ?? 'draft');

  const [info, setInfo] = useState<EditionResearch | null>(null);
  const [runs, setRuns] = useState<ResearchRun[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [revertTarget, setRevertTarget] = useState<ResearchRun | null>(null);
  const [lastSeenComplete, setLastSeenComplete] = useState<string | null>(null);

  // The server knows whether a send has started; until it answers, go by status.
  const canWrite = statusOpen && UUID.test(editionId) && info?.research_open !== false;

  const latest = useMemo(() => info?.blocks.find((b) => b.id === block.id)?.latest_run ?? null, [info, block.id]);
  const blockRuns = useMemo(() => runs.filter((r) => r.block_id === block.id), [runs, block.id]);
  const latestComplete = useMemo(() => blockRuns.find((r) => r.status === 'complete') ?? (latest?.status === 'complete' ? latest : null), [blockRuns, latest]);

  const refresh = useCallback(async () => {
    if (!UUID.test(editionId)) return;
    try {
      const [i, r] = await Promise.all([researchService.edition(editionId), researchService.runs(editionId)]);
      setInfo(i);
      setRuns(r.runs);
    } catch (e) {
      console.warn('[research-panel] failed to load runs:', e);
    }
  }, [editionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while a run is in flight; when it completes, pull the new research
  // layer into the editor (the host adopts it when nothing else changed).
  const inFlight = latest?.status === 'queued' || latest?.status === 'running';
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [inFlight, refresh]);
  useEffect(() => {
    if (latest?.status === 'complete' && latest.id !== lastSeenComplete) {
      setLastSeenComplete(latest.id);
      if (lastSeenComplete !== null) void onResearchChanged();
    }
  }, [latest, lastSeenComplete, onResearchChanged]);

  if (!binding) return null;
  const field = binding.output.field;
  const research = block.content[field];
  const editsRaw = block.content.research_edits;
  const format = researchOutputFormat(binding);
  const useCase = researchUseCaseOf(binding);
  const transform = (binding.transform ?? {}) as { kind?: string; group_by?: string; max_items?: number; max_per_group?: number };

  // ---- writes -------------------------------------------------------------
  const writeEdits = async (edits: Record<string, unknown>, label: string) => {
    if (!canWrite) { toast.error('Research edits can only be made on a draft or published edition that has not started sending'); return; }
    setBusy(label);
    try {
      let attempt = 0;
      for (;;) {
        const { data, error } = await supabase.rpc('newsletters_research_edits_write', {
          p_block_id: block.id,
          p_edits: edits,
          p_expected_version: getVersion(),
        });
        if (!error) {
          onEditsWritten(block.id, edits, typeof data === 'number' ? data : getVersion() + 1);
          return;
        }
        if (isConflict(error) && attempt === 0) {
          attempt++;
          const adopted = await onResearchChanged();
          if (adopted) continue;
          toast.error('This edition was changed elsewhere since you opened it. Reload to get the latest before editing research.', { duration: 12000 });
          return;
        }
        throw error;
      }
    } catch (e) {
      toast.error(`Could not save ${label}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try { await fn(); } catch (e) { toast.error(`${label} failed: ${(e as Error).message}`); } finally { setBusy(null); }
  };
  const runNow = () => act('Run now', async () => {
    const r = await researchService.run(editionId, block.id);
    if (r.busy.length) toast.info('A run is already in flight for this block');
    else toast.success('Research queued');
    await refresh();
  });
  const cancel = () => act('Cancel', async () => {
    if (!latest) return;
    await researchService.cancel(latest.id);
    toast.success('Run cancelled');
    await refresh();
  });
  const revert = () => act('Revert', async () => {
    if (!revertTarget) return;
    const target = revertTarget;
    setRevertTarget(null);
    await researchService.revert(target.id);
    toast.success('Reverted: that run’s output is the research layer again');
    await refresh();
    await onResearchChanged();
  });

  const disabled = busy !== null;

  return (
    <div className="mt-4 border-t border-[var(--gray-a5)] pt-4 text-sm text-[var(--gray-12)] space-y-4" data-testid="research-panel">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Research</h3>
        {latest && <Badge variant="soft" color={statusColor(latest)}>{latest.status}</Badge>}
      </div>

      {/* Binding summary */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-[var(--gray-11)]">
        <dt>Input</dt><dd>{binding.input.kind}{binding.input.kind === 'recipe' ? ` (${binding.input.use_case})` : ''}</dd>
        <dt>Transform</dt>
        <dd>
          {transform.kind ?? 'template'}
          {transform.kind === 'recipe' && (binding.transform as { use_case?: string }).use_case ? ` (${(binding.transform as { use_case?: string }).use_case})` : ''}
          {transform.group_by ? ` · by ${transform.group_by}` : ''}
          {transform.max_per_group ? ` · ≤${transform.max_per_group}/group` : ''}
          {transform.max_items ? ` · ≤${transform.max_items}` : ''}
        </dd>
        <dt>Output</dt><dd>{field} ({format})</dd>
        <dt>Schedule</dt><dd>{binding.schedule ?? 'edition'}{info?.effective_research_at && (binding.schedule ?? 'edition') === 'edition' ? ` · due ${fmtTime(info.effective_research_at)}` : ''}</dd>
      </dl>

      {/* Latest run */}
      <div className="rounded-md border border-[var(--gray-a5)] p-3 space-y-1 text-xs">
        {latest ? (
          <>
            <div className="flex items-center gap-2">
              <span className="font-medium text-[var(--gray-12)]">Latest run</span>
              <Badge variant="soft" color="gray">{latest.triggered_by}</Badge>
              {latest.failure_kind && <Badge variant="soft" color="red">{latest.failure_kind}</Badge>}
            </div>
            <div className="text-[var(--gray-11)]">Started {fmtTime(latest.started_at)} · Completed {fmtTime(latest.completed_at)} · Cost {fmtCost(latest.cost_micro_usd)}</div>
            {latest.error && <div className="text-[var(--red-11)] break-words">{latest.error}</div>}
          </>
        ) : (
          <div className="text-[var(--gray-11)]">Research has not run yet for this block.</div>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="1" variant="solid" onClick={runNow} disabled={disabled || !canWrite || inFlight}>
            <ArrowPathIcon className="size-3.5" /> Run now
          </Button>
          {inFlight && (
            <Button size="1" variant="outline" color="red" onClick={cancel} disabled={disabled}>
              <StopCircleIcon className="size-3.5" /> Cancel
            </Button>
          )}
          <Button size="1" variant="ghost" onClick={() => setHistoryOpen((v) => !v)}>
            {historyOpen ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />} History ({blockRuns.length})
          </Button>
        </div>
        {historyOpen && (
          <ul className="divide-y divide-[var(--gray-a4)] pt-1">
            {blockRuns.length === 0 && <li className="py-1 text-[var(--gray-9)]">No runs yet.</li>}
            {blockRuns.map((r) => (
              <li key={r.id} className="py-1.5 flex items-center gap-2">
                <Badge variant="soft" color={statusColor(r)}>{r.status}</Badge>
                <span className="text-[var(--gray-11)] flex-1 truncate">{r.triggered_by} · {fmtTime(r.completed_at ?? r.started_at ?? r.scheduled_for)} · {fmtCost(r.cost_micro_usd)}{r.failure_kind ? ` · ${r.failure_kind}` : ''}</span>
                {r.status === 'complete' && r.id !== latestComplete?.id && (
                  <Button size="1" variant="ghost" onClick={() => setRevertTarget(r)} disabled={disabled || !canWrite || inFlight} title="Revert to this run">
                    <ArrowUturnLeftIcon className="size-3.5" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Output */}
      {format === 'array' ? (
        <ArrayOutput
          research={research}
          editsRaw={editsRaw}
          hash={hash}
          transform={transform}
          disabled={disabled || !canWrite}
          onWrite={(edits) => writeEdits(edits as unknown as Record<string, unknown>, 'edits')}
        />
      ) : (
        <ScalarOutput
          research={research}
          editsRaw={editsRaw}
          hash={hash}
          format={format}
          latestComplete={latestComplete}
          runs={blockRuns}
          disabled={disabled || !canWrite}
          onWrite={(edits) => writeEdits(edits, 'edits')}
        />
      )}

      {/* Chat to refine (spec §5.4): only when a recipe was involved. */}
      {latest?.ai_thread_id && useCase && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-[var(--gray-11)]">Refine with chat</h4>
          <div className="h-[420px] flex flex-col min-h-0 rounded-md border border-[var(--gray-a5)] overflow-hidden">
            <AiChatModelTabs useCase={useCase} hostKind="newsletter_block" hostId={block.id} />
          </div>
          {/* TODO(research-blocks §5.4): "Apply to block" for an assistant turn
              with a structured output. The server-side chat-apply route (record
              a `manual` run pointing at this thread, write the research layer
              through newsletters_research_write, clear a scalar/richtext edit
              layer after confirm) is not built yet. When it exists, pass
              `renderAssistantTurn` here and POST the chosen turn to it; do NOT
              reuse the revert route for this. */}
        </div>
      )}

      <ConfirmModal
        isOpen={revertTarget !== null}
        onClose={() => setRevertTarget(null)}
        onConfirm={revert}
        title="Revert to this run?"
        message={`A new run will copy the output of the ${revertTarget?.triggered_by ?? ''} run from ${fmtTime(revertTarget?.completed_at)} into the research layer. Your edits are kept and still apply.`}
        confirmText="Revert"
        confirmColor="blue"
        isProcessing={busy === 'Revert'}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Array outputs
// ---------------------------------------------------------------------------

interface ArrayOutputProps {
  research: unknown;
  editsRaw: unknown;
  hash: string;
  transform: { group_by?: string; max_items?: number; max_per_group?: number };
  disabled: boolean;
  onWrite: (edits: ArrayEdits) => Promise<void>;
}

interface ItemForm { headline: string; url: string; summary: string; group: string }
const emptyForm = (group = ''): ItemForm => ({ headline: '', url: '', summary: '', group });

function ArrayOutput({ research, editsRaw, hash, transform, disabled, onWrite }: ArrayOutputProps): ReactElement {
  const [editing, setEditing] = useState<{ key: string; form: ItemForm } | null>(null);
  const [adding, setAdding] = useState<ItemForm | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);

  const parsed = asResearchEdits(editsRaw);
  const usable: ArrayEdits | null = parsed && parsed.format === 'array' && parsed.binding_hash === hash ? parsed : null;
  const setAside = !!parsed && !usable;
  const resolved = resolveResearchArray(research, editsRaw, transform, hash);
  const groups: ResolvedGroup[] = transform.group_by
    ? (resolved.value as ResolvedGroup[])
    : [{ group: '', items: resolved.value as ResearchItem[] }];
  const base: ResearchItem[] = Array.isArray(research) ? (research as unknown[]).filter((i): i is ResearchItem => typeof i === 'object' && i !== null && typeof (i as ResearchItem).key === 'string') : [];
  const baseByKey = new Map(base.map((i) => [i.key, i]));
  const removed = (usable?.removed ?? []).map((k) => baseByKey.get(k)).filter((i): i is ResearchItem => !!i);
  const pinned = new Set(usable?.pinned ?? []);
  const groupNames = Array.from(new Set([...base.map((i) => String(i.group ?? '')), ...(usable?.added ?? []).map((i) => String(i.group ?? ''))].filter(Boolean))).sort();

  // Every write starts from the usable edit layer, or a fresh one for the
  // current binding (an edit layer set aside by a binding change is replaced).
  const next = (mut: (e: ArrayEdits) => void): ArrayEdits => {
    const e: ArrayEdits = {
      format: 'array',
      binding_hash: hash,
      overrides: { ...(usable?.overrides ?? {}) },
      removed: [...(usable?.removed ?? [])],
      added: [...(usable?.added ?? [])],
      pinned: [...(usable?.pinned ?? [])],
    };
    mut(e);
    if (e.overrides && Object.keys(e.overrides).length === 0) delete e.overrides;
    if (e.removed && e.removed.length === 0) delete e.removed;
    if (e.added && e.added.length === 0) delete e.added;
    if (e.pinned && e.pinned.length === 0) delete e.pinned;
    return e;
  };

  const togglePin = (key: string) => onWrite(next((e) => {
    e.pinned = pinned.has(key) ? e.pinned!.filter((k) => k !== key) : [...e.pinned!, key];
  }));
  const remove = (item: ResearchItem) => onWrite(next((e) => {
    if (item._added) e.added = e.added!.filter((i) => i.key !== item.key);
    else if (!e.removed!.includes(item.key)) e.removed!.push(item.key);
    e.pinned = e.pinned!.filter((k) => k !== item.key);
    if (e.overrides) delete e.overrides[item.key];
  }));
  const restore = (key: string) => onWrite(next((e) => { e.removed = e.removed!.filter((k) => k !== key); }));

  const startEdit = (item: ResearchItem) => setEditing({
    key: item.key,
    form: { headline: String(item.headline ?? ''), url: String(item.url ?? ''), summary: String(item.summary ?? ''), group: String(item.group ?? '') },
  });
  const validUrl = (url: string) => /^https:\/\/[^\s]+$/i.test(url.trim());
  const saveEdit = async () => {
    if (!editing) return;
    const { key, form } = editing;
    if (!form.headline.trim()) { toast.error('Headline is required'); return; }
    if (form.url && !validUrl(form.url)) { toast.error('URL must start with https://'); return; }
    await onWrite(next((e) => {
      const addedIdx = e.added!.findIndex((i) => i.key === key);
      if (addedIdx >= 0) {
        e.added![addedIdx] = { ...e.added![addedIdx], headline: form.headline.trim(), url: form.url.trim(), summary: form.summary.trim() };
        return;
      }
      const orig = baseByKey.get(key);
      const ov: Record<string, unknown> = {};
      if (form.headline.trim() !== String(orig?.headline ?? '')) ov.headline = form.headline.trim();
      if (form.url.trim() !== String(orig?.url ?? '')) ov.url = form.url.trim();
      if (form.summary.trim() !== String(orig?.summary ?? '')) ov.summary = form.summary.trim();
      e.overrides = e.overrides ?? {};
      if (Object.keys(ov).length === 0) delete e.overrides[key];
      else e.overrides[key] = ov;
    }));
    setEditing(null);
  };
  const saveAdd = async () => {
    if (!adding) return;
    const f = adding;
    if (!f.headline.trim()) { toast.error('Headline is required'); return; }
    if (!validUrl(f.url)) { toast.error('URL must start with https://'); return; }
    if (transform.group_by && !f.group.trim()) { toast.error('Pick a group'); return; }
    const key = keyForUrl(f.url.trim());
    if (baseByKey.has(key) || (usable?.added ?? []).some((i) => i.key === key)) { toast.error('That link is already in the list'); return; }
    await onWrite(next((e) => {
      e.added!.push({
        key,
        group: f.group.trim() || null,
        headline: f.headline.trim(),
        url: f.url.trim(),
        summary: f.summary.trim(),
        published_at: new Date().toISOString(),
        source: 'Added by editor',
      });
      e.removed = e.removed!.filter((k) => k !== key);
    }));
    setAdding(null);
  };

  const total = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-[var(--gray-11)]">Items ({total})</h4>
        <Button size="1" variant="outline" onClick={() => setAdding(emptyForm(groupNames[0] ?? ''))} disabled={disabled || adding !== null}>
          <PlusIcon className="size-3.5" /> Add item
        </Button>
      </div>

      {setAside && (
        <div className="rounded-md border border-[var(--orange-a6)] bg-[var(--orange-a2)] p-2 text-xs text-[var(--orange-11)]">
          Edits from a previous block version were set aside: the block&rsquo;s research binding changed since they were made. Re-apply them by hand; the next edit you save replaces them.
          <details className="mt-1"><summary className="cursor-pointer">What they were</summary><pre className="whitespace-pre-wrap break-all text-[10px]">{JSON.stringify(parsed, null, 1)}</pre></details>
        </div>
      )}
      {resolved.stale_keys.length > 0 && !setAside && (
        <div className="text-[10px] text-[var(--gray-9)]">{resolved.stale_keys.length} edit(s) refer to items the latest run no longer returns.</div>
      )}

      {adding && (
        <ItemFormFields
          form={adding}
          groups={groupNames}
          requireGroup={!!transform.group_by}
          onChange={setAdding}
          onCancel={() => setAdding(null)}
          onSave={saveAdd}
          saveLabel="Add"
          disabled={disabled}
        />
      )}

      {total === 0 && !adding && <div className="text-xs text-[var(--gray-9)]">Nothing to show yet.</div>}

      {groups.map((g) => (
        <div key={g.group || '_'} className="space-y-1">
          {g.group && <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--gray-10)] pt-1">{g.group}</div>}
          <ul className="space-y-1">
            {g.items.map((item) => (
              <li key={item.key} className="rounded-md border border-[var(--gray-a5)] p-2 text-xs">
                {editing?.key === item.key ? (
                  <ItemFormFields
                    form={editing.form}
                    groups={groupNames}
                    requireGroup={false}
                    lockGroup
                    onChange={(form) => setEditing({ key: item.key, form })}
                    onCancel={() => setEditing(null)}
                    onSave={saveEdit}
                    saveLabel="Save"
                    disabled={disabled}
                  />
                ) : (
                  <>
                    <div className="flex items-start gap-1.5">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-[var(--gray-12)] break-words">
                          {typeof item.url === 'string' && item.url ? (
                            <a href={item.url} target="_blank" rel="noreferrer noopener" className="hover:underline">{String(item.headline ?? '(no headline)')}</a>
                          ) : String(item.headline ?? '(no headline)')}
                        </div>
                        <div className="text-[var(--gray-9)]">
                          {item.published_at ? new Date(item.published_at).toLocaleDateString() : 'undated'}
                          {pinned.has(item.key) && <span> · pinned</span>}
                          {item._added ? <span> · added</span> : null}
                          {usable?.overrides?.[item.key] && <span> · edited</span>}
                        </div>
                        {typeof item.summary === 'string' && item.summary && <div className="text-[var(--gray-11)] mt-0.5 break-words">{item.summary}</div>}
                      </div>
                      <div className="flex flex-col gap-0.5 shrink-0">
                        <button type="button" title={pinned.has(item.key) ? 'Unpin' : 'Pin to top of group'} disabled={disabled} onClick={() => void togglePin(item.key)} className={`p-1 rounded hover:bg-[var(--gray-a3)] ${pinned.has(item.key) ? 'text-[var(--accent-11)]' : 'text-[var(--gray-10)]'}`}>
                          <MapPinIcon className="size-3.5" />
                        </button>
                        <button type="button" title="Edit" disabled={disabled} onClick={() => startEdit(item)} className="p-1 rounded hover:bg-[var(--gray-a3)] text-[var(--gray-10)]">
                          <PencilSquareIcon className="size-3.5" />
                        </button>
                        <button type="button" title="Remove" disabled={disabled} onClick={() => void remove(item)} className="p-1 rounded hover:bg-[var(--red-a3)] text-[var(--gray-10)] hover:text-[var(--red-11)]">
                          <TrashIcon className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {removed.length > 0 && (
        <div>
          <button type="button" className="text-xs text-[var(--gray-10)] hover:underline flex items-center gap-1" onClick={() => setShowRemoved((v) => !v)}>
            {showRemoved ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />} Removed ({removed.length})
          </button>
          {showRemoved && (
            <ul className="mt-1 space-y-1">
              {removed.map((item) => (
                <li key={item.key} className="flex items-center gap-2 text-xs text-[var(--gray-10)] line-through">
                  <span className="flex-1 truncate">{String(item.headline ?? item.key)}</span>
                  <Button size="1" variant="ghost" disabled={disabled} onClick={() => void restore(item.key)}>Restore</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ItemFormFields(props: {
  form: ItemForm;
  groups: string[];
  requireGroup: boolean;
  lockGroup?: boolean;
  onChange: (f: ItemForm) => void;
  onCancel: () => void;
  onSave: () => void | Promise<void>;
  saveLabel: string;
  disabled: boolean;
}): ReactElement {
  const { form, groups, requireGroup, lockGroup, onChange, onCancel, onSave, saveLabel, disabled } = props;
  const input = 'w-full px-2 py-1 text-xs border border-[var(--gray-a6)] rounded bg-[var(--color-surface)] text-[var(--gray-12)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-8)]';
  return (
    <div className="space-y-1.5 rounded-md border border-[var(--accent-a6)] p-2 text-xs">
      <input className={input} placeholder="Headline" value={form.headline} onChange={(e) => onChange({ ...form, headline: e.target.value })} />
      <div className="flex items-center gap-1">
        <LinkIcon className="size-3.5 text-[var(--gray-9)] shrink-0" />
        <input className={input} placeholder="https://…" value={form.url} onChange={(e) => onChange({ ...form, url: e.target.value })} inputMode="url" />
      </div>
      <textarea className={`${input} resize-y`} rows={2} placeholder="Summary (optional)" value={form.summary} onChange={(e) => onChange({ ...form, summary: e.target.value })} />
      {!lockGroup && (requireGroup || groups.length > 0) && (
        <select className={input} value={form.group} onChange={(e) => onChange({ ...form, group: e.target.value })}>
          <option value="">{requireGroup ? 'Pick a group…' : 'No group'}</option>
          {groups.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
      )}
      <div className="flex gap-2 justify-end">
        <Button size="1" variant="ghost" onClick={onCancel} disabled={disabled}>Cancel</Button>
        <Button size="1" variant="solid" onClick={() => void onSave()} disabled={disabled}>{saveLabel}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scalar / richtext outputs
// ---------------------------------------------------------------------------

interface ScalarOutputProps {
  research: unknown;
  editsRaw: unknown;
  hash: string;
  format: 'richtext' | 'text';
  latestComplete: ResearchRun | null;
  runs: ResearchRun[];
  disabled: boolean;
  onWrite: (edits: Record<string, unknown>) => Promise<void>;
}

function ScalarOutput({ research, editsRaw, hash, format, latestComplete, runs, disabled, onWrite }: ScalarOutputProps): ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const parsed = asResearchEdits(editsRaw);
  const r = resolveResearchScalar(research, editsRaw, hash, format);
  const fromRunId = parsed && parsed.format !== 'array' ? parsed.from_run_id ?? null : null;
  const fromRun = fromRunId ? runs.find((x) => x.id === fromRunId) : undefined;
  // A newer run applied since the edit: the edit's run is known and older,
  // or unknown and the latest complete run is a different one.
  const newerResearch = r.edited && !!latestComplete && latestComplete.id !== fromRunId && (!fromRun || latestComplete.seq > fromRun.seq);
  const asText = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

  const reset = () => onWrite({ format, binding_hash: hash });
  const save = async () => {
    if (draft === null) return;
    await onWrite({ format, binding_hash: hash, value: draft, from_run_id: latestComplete?.id ?? null });
    setDraft(null);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-[var(--gray-11)]">Text</h4>
        <div className="flex items-center gap-1.5">
          {r.edited ? <Badge variant="soft" color="blue">edited</Badge> : <Badge variant="soft" color="gray">research</Badge>}
          {newerResearch && <Badge variant="soft" color="orange">newer research available</Badge>}
        </div>
      </div>
      {r.edits_set_aside && (
        <div className="rounded-md border border-[var(--orange-a6)] bg-[var(--orange-a2)] p-2 text-xs text-[var(--orange-11)]">
          An edit from a previous block version was set aside (the research binding changed). The research text is shown.
          <details className="mt-1"><summary className="cursor-pointer">What it was</summary><pre className="whitespace-pre-wrap break-all text-[10px]">{asText((parsed as { value?: unknown } | null)?.value)}</pre></details>
        </div>
      )}
      {draft !== null ? (
        <div className="space-y-1.5">
          <textarea
            className="w-full px-2 py-1 text-xs border border-[var(--gray-a6)] rounded bg-[var(--color-surface)] text-[var(--gray-12)] resize-y font-mono"
            rows={8}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          {format === 'richtext' && <div className="text-[10px] text-[var(--gray-9)]">Raw HTML. The research text stays underneath; Reset to research brings it back.</div>}
          <div className="flex gap-2 justify-end">
            <Button size="1" variant="ghost" onClick={() => setDraft(null)} disabled={disabled}>Cancel</Button>
            <Button size="1" variant="solid" onClick={() => void save()} disabled={disabled}>Save edit</Button>
          </div>
        </div>
      ) : (
        <>
          <pre className="whitespace-pre-wrap break-words rounded-md border border-[var(--gray-a5)] p-2 text-xs text-[var(--gray-12)] max-h-48 overflow-auto">{asText(r.value) || '(empty)'}</pre>
          {r.edited && (
            <details className="text-xs text-[var(--gray-10)]">
              <summary className="cursor-pointer">Research text</summary>
              <pre className="whitespace-pre-wrap break-words mt-1 p-2 border border-dashed border-[var(--gray-a5)] rounded-md max-h-48 overflow-auto">{asText(research) || '(empty)'}</pre>
            </details>
          )}
          <div className="flex gap-2 justify-end">
            {r.edited && (
              <Button size="1" variant="outline" onClick={() => void reset()} disabled={disabled}>
                <ArrowUturnLeftIcon className="size-3.5" /> Reset to research
              </Button>
            )}
            <Button size="1" variant="outline" onClick={() => setDraft(asText(r.edited ? (parsed as { value?: unknown } | null)?.value : r.value))} disabled={disabled}>
              <PencilSquareIcon className="size-3.5" /> Edit text
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export default ResearchPanel;
