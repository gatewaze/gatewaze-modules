// @ts-nocheck
/**
 * Software Engineer dashboard (spec §14 / §14.1). Standard admin dashboard shell: Page + hero
 * header + Tabs, matching the other dashboards (e.g. Emails). Tabs:
 *   - Overview — read-only KPI tiles + status/phase/project rollups (default landing).
 *   - Runs  — runs board + live "watch the agent" view (streamed events, chat/steer, override).
 *   - Issues — report/triage issues across projects.
 *   - Setup — per-brand credentials + repos (SetupPanel).
 * Admin design system (Tailwind + @/components/ui, Radix gray vars). No @radix-ui/themes import.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { Badge, Button, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import {
  CommandLineIcon, Cog6ToothIcon, ArrowPathIcon, ArrowUturnLeftIcon,
  XCircleIcon, PaperAirplaneIcon, ArrowTopRightOnSquareIcon, ArchiveBoxIcon, ClipboardDocumentListIcon,
  ChartBarIcon, PlayCircleIcon, StopCircleIcon, ArrowDownIcon, ArrowsRightLeftIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import SetupPanel from './SetupPanel';
import RunTimeline from './RunTimeline';
import TranscriptMarkdown from './TranscriptMarkdown';
import TestEnvPanel from './TestEnvPanel';
import TriageCopilot from './TriageCopilot';
import { ProjectAvatar } from './ProjectAvatar';
import { projectOptionLabel } from './projectAvatarUtils';
import { issueKey, mergeIssues, pendingOptimistic } from './issueList';
import OverviewView from './OverviewView';
import { ALL_RUN_STATUSES, STATUS_LABELS, toggleStatusInParam, fmtCost } from './overview-filters';
import { aggregateRunModelCosts, shortModel } from '../lib/run-costs';
import { isNearBottom } from './autoscroll';
import { resumeBlockedReason } from './resumeButton';

// Absolute API base on deployed admins (nginx serves the SPA only — no /api proxy); '' locally → Vite proxy.
const API = `${(import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? ''}/api/modules/software-engineer/admin`;

async function api(path: string, init?: RequestInit) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const r = await fetch(`${API}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}

const STATUS_COLOR: Record<string, string> = {
  merged: 'green', pr_open: 'amber', watching: 'blue', changes_requested: 'amber',
  running: 'blue', failed: 'red', blocked: 'red', closed: 'gray', cancelled: 'gray', queued: 'gray',
  awaiting_architecture: 'amber', architecture_in_review: 'amber', ready_to_submit: 'amber', awaiting_spec: 'amber',
};
const phaseColor = (s: string) =>
  s === 'passed' ? 'green' : s === 'failed' || s === 'blocked' ? 'red' : s === 'running' ? 'blue' : 'gray';

// Human prose for the run's current phase — so a live run reads as continuous progress rather than
// only jumping on turn boundaries. Falls back to the raw phase for any phase not enumerated here.
const PHASE_PROSE: Record<string, string> = {
  intake: 'Reading the issue and planning the work',
  spec: 'Writing the change spec',
  review: 'Reviewing the spec',
  architecture: 'Architecture review',
  implement: 'Writing the code',
  verify: 'Running checks and tests',
  revise: 'Revising in response to feedback',
  pr: 'Opening the pull request',
  watch: 'Watching the pull request',
  merge: 'Merging',
};
const phaseProse = (p?: string) => (p && PHASE_PROSE[p]) || (p ? `Working (${p})` : 'Working');

/**
 * Fixed header cost strip (§ accurate per-run metrics): the authoritative total (SDK-metered from
 * migration 018; live phases tick from heartbeat estimates) plus a per-model breakdown so routing
 * decisions can see where the money goes — including the harness's own utility-model (Haiku) spend.
 * The detail poller/realtime refetch keeps it updating while the run works.
 */
function RunCostStrip({ phases, live }: { phases: any[]; live: boolean }) {
  const { total, rows } = aggregateRunModelCosts(phases);
  if (!(total > 0)) return null;
  return (
    <div className="mb-2 flex items-baseline gap-3 flex-wrap">
      <span className="font-mono text-base font-semibold text-[var(--gray-12)]">
        {fmtCost(total)}{live ? <span className="text-[var(--gray-9)] font-normal text-xs"> · running</span> : null}
      </span>
      {rows.map((r) => (
        <span key={r.model} className="font-mono text-[11px] text-[var(--gray-10)]" title={r.model}>
          {shortModel(r.model)} {fmtCost(r.costUSD) || '<$0.01'}
        </span>
      ))}
    </div>
  );
}

// A run's headline label. Interactive (pair-programming) sessions have no issue, so they read as a
// session on their project rather than "owner/repo #n".
const runLabel = (r: any): string =>
  r?.kind === 'interactive'
    ? `Interactive session${r.project?.name ? ` · ${r.project.name}` : ''}`
    : `${r?.repo_owner}/${r?.repo_name} #${r?.issue_number}`;

// One-line label promoting the latest live event out of the collapsed "Tool activity" block, so the
// working strip shows what the agent is doing *right now* between turn-boundary transcript messages.
function eventLabel(ev: any): string {
  if (!ev) return '';
  const p = ev.payload ?? {};
  switch (ev.kind) {
    case 'tool_use': return `Running ${p.name ?? 'a tool'}`;
    case 'tool_result': return 'Reading the result';
    case 'thinking': return p.text ? `Thinking — ${String(p.text).replace(/\s+/g, ' ').slice(0, 120)}` : 'Thinking…';
    case 'status': return String(p.text ?? p.step ?? 'Working…');
    case 'assistant': return p.text ? String(p.text).replace(/\s+/g, ' ').slice(0, 120) : 'Writing…';
    default: return String(ev.kind ?? '');
  }
}

const THROTTLE_MS = 500;   // coalesce bursts of realtime events into at most one detail refetch / window

function RunsView({ selected, onSelect, onGoToSetup }: { selected: string | null; onSelect: (id: string | null) => void; onGoToSetup: () => void }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [detail, setDetail] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [chatAtts, setChatAtts] = useState<any[]>([]);   // pasted/dropped screenshots → uploaded to `media`
  const [err, setErr] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [projectList, setProjectList] = useState<any[]>([]);
  // Project + status filters live in the URL so a filtered board is shareable and the Overview tiles
  // can deep-link into it. '' = all. `status` is a comma-separated set from a fixed allowlist.
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const projectFilter = searchParams.get('project') ?? '';   // '' = all projects
  const statusFilter = searchParams.get('status') ?? '';     // '' = no status filter
  // Navigate to the runs board (deselecting any open run) with the search params mutated in place.
  const goRuns = useCallback((mutate: (p: URLSearchParams) => void) => {
    const p = new URLSearchParams(searchParams);
    mutate(p);
    const qs = p.toString();
    navigate(`${BASE}/runs${qs ? `?${qs}` : ''}`);
  }, [navigate, searchParams]);
  const [startProject, setStartProject] = useState('');     // project for a new interactive session
  const [starting, setStarting] = useState(false);
  const [merging, setMerging] = useState(false);            // guard against a double manual-merge submit
  const [submitting, setSubmitting] = useState(false);      // guard against a double PR-submit click
  const [resuming, setResuming] = useState(false);          // guard against a double resume click
  const lastActivityRef = useRef<number>(Date.now());       // epoch ms of the last realtime signal for `selected`
  const [, tick] = useState(0);                             // 1s ticker so "updated Ns ago" recomputes
  const transcript = useRef<HTMLDivElement | null>(null);   // the transcript scroll container (bounded, scrolls internally)
  const content = useRef<HTMLDivElement | null>(null);      // the growing content inside it (observed for height changes)
  // "Tail the live stream" intent. True = keep pinned to the newest content; flips to false the moment
  // the user scrolls up to read scrollback, so a burst of events doesn't yank them back down. A ref
  // mirror lets the ResizeObserver callback read the latest value without being torn down on each flip.
  const [stickToBottom, setStickToBottom] = useState(true);
  const stickRef = useRef(true);
  stickRef.current = stickToBottom;

  useEffect(() => { api('/projects').then((d) => { const list = d.projects ?? []; setProjectList(list); setStartProject((v) => v || list[0]?.id || ''); }).catch(() => {}); }, []);

  const loadRuns = useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (showArchived) p.set('archived', '1');
      if (projectFilter) p.set('project', projectFilter);
      if (statusFilter) p.set('status', statusFilter);
      const qs = p.toString();
      setRuns((await api(`/runs${qs ? `?${qs}` : ''}`)).runs ?? []); setErr(null);
    } catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setLoading(false); }
  }, [showArchived, projectFilter, statusFilter]);
  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await api(`/runs/${id}`)); } catch (e: any) { setErr(String(e.message ?? e)); }
  }, []);

  useEffect(() => {
    loadRuns();
    const ch = supabase.channel('se-runs-board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'se_runs' }, () => loadRuns())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [loadRuns]);

  useEffect(() => {
    setChatAtts([]);   // don't carry a pending upload from one run into another
    if (!selected) { setDetail(null); return; }
    lastActivityRef.current = Date.now();
    loadDetail(selected);
    // Throttle refetches: se_events can burst (one row per tool call), and each realtime signal here
    // triggers a *full* run refetch. Coalesce to a leading + trailing call per THROTTLE_MS window so a
    // busy phase doesn't hammer /runs/:id. Any signal also refreshes the freshness clock below.
    let timer: any = null;
    let trailing = false;
    const bump = () => {
      lastActivityRef.current = Date.now();
      if (timer) { trailing = true; return; }
      loadDetail(selected);
      timer = setTimeout(function fire() {
        timer = null;
        if (trailing) { trailing = false; loadDetail(selected); timer = setTimeout(fire, THROTTLE_MS); }
      }, THROTTLE_MS);
    };
    const ch = supabase.channel(`se-run-${selected}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'se_events', filter: `run_id=eq.${selected}` }, bump)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'se_messages', filter: `run_id=eq.${selected}` }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'se_phases', filter: `run_id=eq.${selected}` }, bump)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'se_runs', filter: `id=eq.${selected}` }, bump)
      .subscribe();
    return () => { if (timer) clearTimeout(timer); supabase.removeChannel(ch); };
  }, [selected, loadDetail]);

  // Opening a run (or switching to another) starts tailing the latest activity rather than the top.
  useEffect(() => { setStickToBottom(true); }, [selected]);

  // Update the tail intent from the user's own scrolling: near the bottom re-arms tailing; scrolling
  // up to read scrollback disarms it. This is the single source of "did the user scroll away?".
  const onTranscriptScroll = useCallback(() => {
    const el = transcript.current;
    if (el) setStickToBottom(isNearBottom(el));
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = transcript.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStickToBottom(true);
  }, []);

  // Pin to the newest content while tailing, by scrolling ONLY the transcript container — never the
  // document (scrollIntoView would move every scrollable ancestor, incl. the page). useLayoutEffect
  // runs BEFORE paint so a large streamed step doesn't flash at the wrong offset; the count-based deps
  // catch new steps/events on each throttled refetch.
  useLayoutEffect(() => {
    const el = transcript.current;
    if (el && stickToBottom) el.scrollTop = el.scrollHeight;
  }, [detail?.messages?.length, detail?.events?.length, stickToBottom, selected]);

  // Content can also grow WITHOUT a count change — a markdown image finishing load, a "Show more"
  // expansion, or an in-place update of the last row. Observe the content box and re-pin on any height
  // change while tailing, so the view never drifts off the bottom. (CSR-only; guarded for the node env.)
  useEffect(() => {
    const el = transcript.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (stickRef.current) el.scrollTop = el.scrollHeight; });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [selected]);

  const liveStatus = ['queued', 'running', 'changes_requested'].includes(detail?.run?.status);

  // Re-render once a second while live so the "updated Ns ago" freshness clock advances — a wedged run
  // (no events, no heartbeat) then reads as visibly stale instead of looking identical to a live one.
  useEffect(() => {
    if (!liveStatus) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [liveStatus]);

  // Paste/drop a screenshot into the live chat → upload to the public `media` bucket, then send its
  // URL with the message so the agent downloads + Reads it (same path as issue attachments).
  const uploadChatImage = async (file: File) => {
    if (!file.type.startsWith('image/')) return;
    if (file.size > 15 * 1024 * 1024) { setErr('image too large (max 15MB)'); return; }
    const key = crypto.randomUUID();
    const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
    const path = `se-runs/${selected || 'unknown'}/${key}.${ext}`;
    setChatAtts((a) => [...a, { key, name: file.name || `${key}.${ext}`, url: '', uploading: true }]);
    try {
      const { error } = await supabase.storage.from('media').upload(path, file, { upsert: false, cacheControl: '3600', contentType: file.type });
      if (error) throw error;
      const { data } = supabase.storage.from('media').getPublicUrl(path);
      setChatAtts((a) => a.map((x) => (x.key === key ? { ...x, uploading: false, url: data.publicUrl } : x)));
    } catch (e: any) { setErr(`image upload failed: ${String(e.message ?? e)}`); setChatAtts((a) => a.filter((x) => x.key !== key)); }
  };
  const onChatPaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData?.items ?? []).filter((it) => it.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    imgs.forEach((it) => { const f = it.getAsFile(); if (f) uploadChatImage(f); });
  };
  const onChatDrop = (e: React.DragEvent) => { e.preventDefault(); Array.from(e.dataTransfer?.files ?? []).forEach(uploadChatImage); };
  const onChatPick = (e: React.ChangeEvent<HTMLInputElement>) => { Array.from(e.target.files ?? []).forEach(uploadChatImage); e.target.value = ''; };
  const removeChatAtt = (key: string) => setChatAtts((a) => a.filter((x) => x.key !== key));
  const chatUploading = chatAtts.some((a) => a.uploading);

  const send = async () => {
    const content = draft;
    const images = chatAtts.filter((a) => a.url).map((a) => a.url);
    if (!selected || chatUploading || (!content.trim() && !images.length)) return;
    setDraft(''); setChatAtts([]);
    try {
      const res = await api(`/runs/${selected}/message`, { method: 'POST', body: JSON.stringify({ content, images }) });
      // The server drops any image URL its SSRF allowlist rejects (e.g. an http://…localhost storage
      // URL in dev). Surface that instead of a silent success — expected on localhost, works in prod.
      if (res?.attachmentsDropped > 0) {
        setErr(`${res.attachmentsDropped} image(s) couldn't be attached — the storage URL isn't publicly reachable over https (expected on localhost; works in staging/production).`);
      }
      await loadDetail(selected);
    }
    catch (e: any) { setErr(String(e.message ?? e)); }
  };
  const override = async () => {
    if (!selected) return;
    const content = window.prompt('Override / redirect the agent (optional message):') ?? undefined;
    try { await api(`/runs/${selected}/interrupt`, { method: 'POST', body: JSON.stringify({ content }) }); } catch (e: any) { setErr(String(e.message ?? e)); }
  };
  const cancel = async () => {
    if (!selected || !window.confirm('Cancel this run?')) return;
    try { await api(`/runs/${selected}/cancel`, { method: 'POST' }); await loadRuns(); await loadDetail(selected); } catch (e: any) { setErr(String(e.message ?? e)); }
  };
  const archive = async (id: string, on: boolean) => {
    try { await api(`/runs/${id}/${on ? 'archive' : 'unarchive'}`, { method: 'POST' }); await loadRuns(); if (selected === id) await loadDetail(id); }
    catch (e: any) { setErr(String(e.message ?? e)); }
  };
  // Manually merge the run's open, mergeable PR(s). The server only merges PRs whose required checks are
  // green (a non-bypass token), so a "held" result is expected, not an error — surface why so a no-op
  // merge isn't a silent success.
  const merge = async () => {
    if (!selected || !window.confirm('Merge this run’s open pull request(s)? Only PRs whose required checks are green will merge.')) return;
    setMerging(true); setErr(null);
    try {
      const r = await api(`/runs/${selected}/merge`, { method: 'POST' });
      if (r && r.merged === 0) {
        const reasons = (r.results ?? [])
          .filter((x: any) => x.outcome === 'held')
          .map((x: any) => `${x.repo}: ${x.reason ?? 'not mergeable'}`)
          .join('; ');
        setErr(`No PRs merged — ${r.held ?? 0} held${reasons ? ` (${reasons})` : ''}. A PR merges only once its required checks are green.`);
      }
      await loadRuns(); await loadDetail(selected);
    } catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setMerging(false); }
  };
  // Resume a FAILED run back into the phase that failed (issue #36) — keeps the run id + full history.
  const resume = async () => {
    if (!selected || !window.confirm('Resume this run? It will retry the phase that failed.')) return;
    setResuming(true); setErr(null);
    try {
      const r = await api(`/runs/${selected}/resume`, { method: 'POST' });
      toast.success(`Resuming — retrying ${r?.phase ?? 'the failed phase'} (attempt ${r?.attempt ?? '?'}).`);
      await loadRuns(); await loadDetail(selected);
    } catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setResuming(false); }
  };
  // Submit a human-gated PR (status ready_to_submit): opens the pull request(s) the agent prepared.
  const submitPr = async () => {
    if (!selected || !window.confirm('Submit the pull request now? This opens it on the code repository.')) return;
    setSubmitting(true); setErr(null);
    try { await api(`/runs/${selected}/submit-pr`, { method: 'POST' }); toast.success('Submitting the pull request…'); await loadRuns(); await loadDetail(selected); }
    catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setSubmitting(false); }
  };
  // §7.6 architecture-review gate (commit-to-main): the draft/committed proposal for a run parked at the
  // gate. The human refines it by chatting (each message re-runs the agent on the draft), FINALIZES it
  // (commit the folder to the arch repo's main, no PR), then APPROVES it to resume implementation.
  const [arch, setArch] = useState<any | null>(null);
  const [archBusy, setArchBusy] = useState<'' | 'load' | 'finalize' | 'approve'>('');
  useEffect(() => {
    setArch(null);
    if (!selected || !['awaiting_architecture', 'architecture_in_review'].includes(detail?.run?.status ?? '')) return;
    let live = true;
    (async () => {
      setArchBusy('load');
      try { const a = await api(`/runs/${selected}/architecture`); if (live) setArch(a); }
      catch { /* the draft may not be readable yet */ }
      finally { if (live) setArchBusy(''); }
    })();
    return () => { live = false; };
  }, [selected, detail?.run?.status]);   // eslint-disable-line react-hooks/exhaustive-deps
  const finalizeArch = async () => {
    if (!selected || !window.confirm('Commit this proposal to the architecture repo’s main branch? It then awaits the architecture team’s review.')) return;
    setArchBusy('finalize'); setErr(null);
    try { const r = await api(`/runs/${selected}/architecture/finalize`, { method: 'POST' }); toast.success('Proposal committed — awaiting architectural review'); if (r?.url) window.open(r.url, '_blank'); await loadRuns(); await loadDetail(selected); }
    catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setArchBusy(''); }
  };
  const approveArch = async () => {
    if (!selected || !window.confirm('Approve the architecture and start implementation?')) return;
    setArchBusy('approve'); setErr(null);
    try { await api(`/runs/${selected}/architecture/approve`, { method: 'POST' }); toast.success('Architecture approved — resuming implementation'); await loadRuns(); await loadDetail(selected); }
    catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setArchBusy(''); }
  };
  // §phase-gates: the SPEC gate. Load the spec for a run parked at `awaiting_spec`; chat refines it,
  // approve advances it. The chat reuses the same draft + send() as the other gates.
  const [specGate, setSpecGate] = useState<any | null>(null);
  const [specBusy, setSpecBusy] = useState(false);
  useEffect(() => {
    setSpecGate(null);
    if (!selected || detail?.run?.status !== 'awaiting_spec') return;
    let live = true;
    (async () => {
      try { const s = await api(`/runs/${selected}/spec`); if (live) setSpecGate(s); }
      catch { /* the spec may not be readable yet */ }
    })();
    return () => { live = false; };
  }, [selected, detail?.run?.status]);   // eslint-disable-line react-hooks/exhaustive-deps
  const approveSpec = async () => {
    if (!selected || !window.confirm('Approve this spec and proceed? This starts the next phase.')) return;
    setSpecBusy(true); setErr(null);
    try { const r = await api(`/runs/${selected}/spec/approve`, { method: 'POST' }); toast.success(`Spec approved — proceeding to ${r?.next ?? 'the next phase'}`); await loadRuns(); await loadDetail(selected); }
    catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setSpecBusy(false); }
  };
  // Manually start a blank interactive engineer on a project, then open it to chat live.
  const startInteractive = async () => {
    const pid = startProject || projectFilter || projectList[0]?.id;
    if (!pid) { setErr('Add a project in Setup first.'); return; }
    setStarting(true); setErr(null);
    try {
      const r = await api('/engineers/interactive', { method: 'POST', body: JSON.stringify({ project_id: pid }) });
      await loadRuns();
      if (r?.runId) onSelect(r.runId);
    } catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setStarting(false); }
  };
  // Explicitly end an interactive session (nothing closes it on its own).
  const closeSession = async () => {
    if (!selected || !window.confirm('End this interactive session? Its scratch workspace is discarded.')) return;
    try { await api(`/runs/${selected}/close`, { method: 'POST' }); await loadRuns(); await loadDetail(selected); }
    catch (e: any) { setErr(String(e.message ?? e)); }
  };

  return (
    // Stack on phones (flex-col), two-pane from lg up. The fixed 100dvh height + overflow trap is
    // gated to lg so mobile scrolls the page normally instead of fighting the browser address bar.
    <div className="flex flex-col lg:flex-row gap-6 lg:h-[calc(100dvh-var(--se-runs-chrome,240px))] lg:overflow-hidden">
      {/* Runs board — full width on mobile; hidden once a run is selected so the detail pane takes over. */}
      <div className={`w-full lg:w-80 shrink-0 lg:overflow-y-auto pr-1 ${selected ? 'hidden lg:block' : 'block'}`}>
        {projectList.length > 1 && (
          <select
            value={projectFilter}
            onChange={(e) => { const v = e.target.value; setDetail(null); goRuns((p) => { if (v) p.set('project', v); else p.delete('project'); }); }}
            className="w-full mb-2 rounded-md border border-[var(--gray-6)] bg-transparent px-2 py-1.5 text-sm"
          >
            <option value="">All projects</option>
            {projectList.map((p) => <option key={p.id} value={p.id}>{projectOptionLabel(p.avatar_emoji, p.name)}</option>)}
          </select>
        )}
        {(() => {
          const selectedStatuses = new Set(statusFilter.split(',').map((s) => s.trim()).filter(Boolean));
          // Multi-select toggle chips, one per se_runs.status value — matches the board's own .in()
          // support (rather than a single-select dropdown) and reuses the KPI-tile deep-link's
          // comma-separated ?status= param, so a tile click hydrates the same chip set as a manual
          // multi-toggle. No popover primitive exists in the kit to collapse 12 chips into a menu.
          const toggle = (status: string) => goRuns((p) => {
            const next = toggleStatusInParam(statusFilter, status);
            if (next) p.set('status', next); else p.delete('status');
          });
          return (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {ALL_RUN_STATUSES.map((status) => {
                const active = selectedStatuses.has(status);
                return (
                  <button
                    key={status}
                    type="button"
                    onClick={() => toggle(status)}
                    aria-pressed={active}
                    className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                      active
                        ? 'border-[var(--accent-8)] bg-[var(--accent-4)] text-[var(--accent-11)] font-medium'
                        : 'border-[var(--gray-6)] bg-transparent text-[var(--gray-11)] hover:bg-[var(--gray-3)]'
                    }`}
                  >
                    {STATUS_LABELS[status] ?? status}
                  </button>
                );
              })}
              {selectedStatuses.size > 0 && (
                <button
                  type="button"
                  onClick={() => goRuns((p) => p.delete('status'))}
                  className="text-xs text-[var(--gray-10)] hover:text-[var(--gray-12)] underline"
                >
                  Clear
                </button>
              )}
            </div>
          );
        })()}
        {!showArchived && projectList.length > 0 && (
          // items-stretch: the auto-height select conforms to the fixed-height
          // Button so both controls line up regardless of the kit's sm height.
          <div className="mb-2 flex items-stretch gap-2">
            {projectList.length > 1 && (
              <select
                value={startProject}
                onChange={(e) => setStartProject(e.target.value)}
                // No vertical padding: keep the select's intrinsic height below the
                // Button's fixed height so flex stretch grows it to match the Button.
                className="min-w-0 flex-1 rounded-md border border-[var(--gray-6)] bg-transparent px-2 text-sm"
                aria-label="Project for a new interactive engineer"
              >
                {projectList.map((p) => <option key={p.id} value={p.id}>{projectOptionLabel(p.avatar_emoji, p.name)}</option>)}
              </select>
            )}
            <Button variant="soft" size="sm" onClick={startInteractive} disabled={starting} className={projectList.length > 1 ? 'shrink-0' : 'w-full'}>
              <PlayCircleIcon className="size-4 mr-1" />{starting ? 'Starting…' : 'Start engineer'}
            </Button>
          </div>
        )}
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--gray-10)]">{showArchived ? 'Archive' : 'Runs'}</div>
          <button onClick={() => { onSelect(null); setDetail(null); setShowArchived((v) => !v); }} className="text-[11px] text-[var(--gray-10)] hover:text-[var(--gray-12)] underline">
            {showArchived ? 'Show active' : 'Show archive'}
          </button>
        </div>
        {err && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 mb-2">{err}</div>}
        {loading ? (
          <div className="flex justify-center p-8"><LoadingSpinner /></div>
        ) : runs.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center space-y-3">
            <CommandLineIcon className="size-8 mx-auto text-[var(--gray-8)]" />
            <p className="font-medium text-[var(--gray-12)]">No runs yet</p>
            <p className="text-xs leading-relaxed text-[var(--gray-11)]">
              1. Add a brand’s GitHub + model credentials and a repo in <strong>Setup</strong>.<br />
              2. Label a GitHub issue <code className="font-mono text-[11px] bg-[var(--gray-3)] px-1 rounded">agent:build</code>.
            </p>
            <Button variant="solid" size="sm" onClick={onGoToSetup}><Cog6ToothIcon className="size-4 mr-1" />Go to Setup</Button>
          </div>
        ) : runs.map((r) => (
          <button
            key={r.id}
            onClick={() => onSelect(r.id)}
            className={`block w-full text-left rounded-md px-3 py-2 mb-1 border transition-colors ${
              selected === r.id ? 'border-[var(--gray-6)] bg-[var(--gray-3)]' : 'border-transparent hover:bg-[var(--gray-2)]'
            }`}
          >
            <div className="text-sm font-medium truncate text-[var(--gray-12)]">{runLabel(r)}</div>
            {r.title && r.kind !== 'interactive' && <div className="text-xs text-[var(--gray-11)] truncate">{r.title}</div>}
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              <Badge color={STATUS_COLOR[r.status] ?? 'gray'} size="1">{r.status}</Badge>
              <span className="text-xs text-[var(--gray-10)]">{r.current_phase}</span>
              {fmtCost(r.cost_usd) && <span className="text-[11px] font-mono text-[var(--gray-10)]" title="Model spend (priced from the AI price book)">{fmtCost(r.cost_usd)}</span>}
              {r.project?.name && <span className="text-[11px] text-[var(--gray-10)] ml-auto inline-flex items-center gap-1"><ProjectAvatar emoji={r.project.avatar_emoji} className="size-3.5" /> {r.project.name}{r.engineer_name ? ` · ${r.engineer_name}` : ''}</span>}
            </div>
          </button>
        ))}
      </div>

      {/* Live agent view — hidden on mobile until a run is selected, then it takes the full width. */}
      <div className={`flex-1 min-w-0 min-h-0 flex-col lg:border-l border-[var(--gray-5)] lg:pl-6 ${selected ? 'flex' : 'hidden lg:flex'}`}>
        {/* Mobile-only back control: reuses the URL-driven selection (onSelect(null) → /runs). */}
        {selected && (
          <button
            onClick={() => onSelect(null)}
            className="lg:hidden mb-3 inline-flex items-center gap-1 self-start text-sm text-[var(--gray-11)] hover:text-[var(--gray-12)]"
          >
            <ArrowUturnLeftIcon className="size-4" />Back to runs
          </button>
        )}
        {!detail ? (
          <div className="m-auto text-[var(--gray-10)] text-sm">Select a run to watch the agent.</div>
        ) : (
          <>
            <div className="pb-3 border-b border-[var(--gray-5)] mb-3">
              <RunCostStrip phases={detail.phases ?? []} live={liveStatus} />
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-[var(--gray-12)]">{runLabel(detail.run)}</span>
                <Badge color={STATUS_COLOR[detail.run.status] ?? 'gray'}>{detail.run.status}</Badge>
                {detail.run.pr_state && detail.run.pr_state !== detail.run.status && (
                  <Badge color={STATUS_COLOR[detail.run.pr_state] ?? 'gray'} variant="soft" size="1">PR: {detail.run.pr_state}</Badge>
                )}
                {detail.run.project?.name && <span className="text-xs text-[var(--gray-10)] inline-flex items-center gap-1"><ProjectAvatar emoji={detail.run.project.avatar_emoji} className="size-4" /> {detail.run.project.name}</span>}
                {detail.run.engineer_name && <span className="text-xs text-[var(--gray-10)]">🧑‍💻 {detail.run.engineer_name}</span>}
                {detail.run.reporter_display_name && <span className="text-xs text-[var(--gray-10)]">· reported by {detail.run.reporter_display_name}</span>}
                {detail.run.revise_count > 0 && <span className="text-xs text-[var(--gray-10)]">· {detail.run.revise_count} revision{detail.run.revise_count > 1 ? 's' : ''}</span>}
                {detail.run.pr_url && (
                  <a href={detail.run.pr_url} target="_blank" rel="noreferrer" className="text-xs text-blue-500 inline-flex items-center gap-1">
                    PR <ArrowTopRightOnSquareIcon className="size-3" />
                  </a>
                )}
                <span className="ml-auto flex items-center gap-2 flex-wrap">
                  {detail.run.kind !== 'interactive' && ['pr_open', 'watching', 'changes_requested'].includes(detail.run.status) && (
                    <Button variant="solid" color="green" size="xs" onClick={merge} disabled={merging}>
                      <ArrowsRightLeftIcon className="size-3.5 mr-1" />{merging ? 'Merging…' : 'Merge'}
                    </Button>
                  )}
                  {detail.run.kind !== 'interactive' && detail.run.status === 'ready_to_submit' && (
                    <Button variant="solid" color="blue" size="xs" onClick={submitPr} disabled={submitting}>
                      <PaperAirplaneIcon className="size-3.5 mr-1" />{submitting ? 'Submitting…' : 'Submit PR'}
                    </Button>
                  )}
                  {detail.run.kind === 'interactive' && detail.run.status === 'running' && (
                    <Button variant="soft" color="red" size="xs" onClick={closeSession}><StopCircleIcon className="size-3.5 mr-1" />End session</Button>
                  )}
                  {detail.run.status === 'failed' && (() => {
                    const blockedReason = resumeBlockedReason(detail.run);
                    return (
                      <span className="inline-flex items-center gap-1.5">
                        <Button
                          variant="solid" color="amber" size="xs" onClick={resume}
                          disabled={resuming || !!blockedReason}
                          title={blockedReason ?? 'Retry the phase that failed, keeping this run’s history'}
                        >
                          <ArrowPathIcon className="size-3.5 mr-1" />{resuming ? 'Resuming…' : 'Resume'}
                        </Button>
                        {blockedReason && <span className="text-xs text-[var(--gray-10)]">{blockedReason}</span>}
                      </span>
                    );
                  })()}
                  <Button variant="soft" size="xs" onClick={override} disabled={!liveStatus}><ArrowUturnLeftIcon className="size-3.5 mr-1" />Override</Button>
                  {detail.run.kind !== 'interactive' && (
                    <Button variant="soft" color="red" size="xs" onClick={cancel} disabled={!liveStatus}><XCircleIcon className="size-3.5 mr-1" />Cancel</Button>
                  )}
                  {detail.run.archived_at
                    ? <Button variant="soft" size="xs" onClick={() => archive(detail.run.id, false)}>Unarchive</Button>
                    : <Button variant="soft" size="xs" onClick={() => archive(detail.run.id, true)}><ArchiveBoxIcon className="size-3.5 mr-1" />Archive</Button>}
                </span>
              </div>
              <div className="mt-2 flex gap-1.5 flex-wrap">
                {detail.phases.map((p: any) => (
                  <Badge key={p.id} color={phaseColor(p.status)} variant="soft" size="1">{p.phase}:{p.status}</Badge>
                ))}
              </div>
            </div>

            {/* §phase-gates: the SPEC gate. Render the self-reviewed spec; chat to refine it; approve to
                proceed to the next phase. This is before any implementation, so a change here is cheap. */}
            {detail.run.status === 'awaiting_spec' && (
              <div className="mt-3 rounded-lg border border-[var(--amber-6)] bg-[var(--amber-2)] p-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-sm font-medium text-[var(--gray-12)]">📝 Spec review</span>
                  {specGate?.budget?.max != null && (
                    <span className="text-xs text-[var(--gray-10)]">refine {specGate.budget.used}/{specGate.budget.max}</span>
                  )}
                </div>
                <p className="text-xs text-[var(--gray-10)] mt-1">The agent wrote and self-reviewed a spec. Read it, chat below to refine it, then <strong>approve</strong> to start the next phase.</p>
                {specGate?.markdown ? (
                  <details className="mt-2" open>
                    <summary className="text-xs text-[var(--gray-11)] cursor-pointer">Spec</summary>
                    <div className="mt-2 max-h-96 overflow-auto rounded border border-[var(--gray-5)] bg-[var(--gray-1)] p-3 text-sm text-[var(--gray-12)]">
                      <TranscriptMarkdown>{specGate.markdown}</TranscriptMarkdown>
                    </div>
                  </details>
                ) : (
                  <div className="mt-2 text-xs text-[var(--gray-10)]">Loading the spec…</div>
                )}
                <div className="mt-3">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Ask the agent to change the spec, e.g. narrow the scope or fix an assumption…"
                    rows={2}
                    className="w-full rounded border border-[var(--gray-6)] bg-[var(--gray-1)] px-2 py-1 text-sm text-[var(--gray-12)]"
                  />
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <Button variant="soft" size="xs" onClick={send} disabled={!draft.trim()}>
                      <PaperAirplaneIcon className="size-3.5 mr-1" />Send to agent
                    </Button>
                    <Button size="xs" onClick={approveSpec} disabled={specBusy}>
                      <ArrowsRightLeftIcon className="size-3.5 mr-1" />{specBusy ? 'Approving…' : 'Approve spec'}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* §7.6 architecture-review gate (commit-to-main): the draft/committed proposal for a run
                parked at the gate. Chat to refine it, finalize to commit it to the arch repo's main, then
                approve to resume implementation. */}
            {['awaiting_architecture', 'architecture_in_review'].includes(detail.run.status) && (() => {
              const committed = detail.run.status === 'architecture_in_review';
              const commitUrl = arch?.commitUrl ?? detail.run.architecture_commit_url;
              return (
                <div className="mt-3 rounded-lg border border-[var(--amber-6)] bg-[var(--amber-2)] p-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-sm font-medium text-[var(--gray-12)]">🏛️ {committed ? 'Architecture proposal — under review' : 'Architecture proposal — draft'}</span>
                    {committed && commitUrl && (
                      <a href={commitUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-500 inline-flex items-center gap-1">
                        View on {detail.run.architecture_repo} <ArrowTopRightOnSquareIcon className="size-3.5" />
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-[var(--gray-10)] mt-1">
                    {committed
                      ? <>The proposal is committed to <code className="font-mono text-[11px]">{detail.run.architecture_repo}</code> and is awaiting the architecture team’s review. You can still chat below to change it, and each change is re-committed. When the review is done, approve to start implementation.</>
                      : <>The agent classified this work as architecture-impacting and drafted a proposal. Review it, chat below to refine it, then <strong>finalize</strong> to commit it to <code className="font-mono text-[11px]">{detail.run.architecture_repo}</code> and send it for architectural review.</>}
                  </p>
                  {archBusy === 'load' && !arch ? (
                    <div className="mt-2 text-xs text-[var(--gray-10)]">Loading the proposal…</div>
                  ) : arch?.plan?.markdown ? (
                    <details className="mt-2" open>
                      <summary className="text-xs text-[var(--gray-11)] cursor-pointer">Proposal · <span className="font-mono text-[11px]">{arch.folder ?? arch.plan?.path}</span></summary>
                      <div className="mt-2 max-h-96 overflow-auto rounded border border-[var(--gray-5)] bg-[var(--gray-1)] p-3 text-sm text-[var(--gray-12)]">
                        <TranscriptMarkdown>{arch.plan.markdown}</TranscriptMarkdown>
                      </div>
                    </details>
                  ) : (
                    <div className="mt-2 text-xs text-[var(--gray-10)]">Proposal preview unavailable.</div>
                  )}
                  {/* Chat to refine — each message re-runs the agent on the draft (and re-commits once finalized). */}
                  <div className="mt-3">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="Ask the agent to change the proposal, e.g. add a migration and backfill note…"
                      rows={2}
                      className="w-full rounded border border-[var(--gray-6)] bg-[var(--gray-1)] px-2 py-1 text-sm text-[var(--gray-12)]"
                    />
                    <div className="mt-2 flex items-center gap-2 flex-wrap">
                      <Button variant="soft" size="xs" onClick={send} disabled={!draft.trim()}>
                        <PaperAirplaneIcon className="size-3.5 mr-1" />Send to agent
                      </Button>
                      {committed ? (
                        <Button size="xs" onClick={approveArch} disabled={archBusy !== ''}>
                          <ArrowsRightLeftIcon className="size-3.5 mr-1" />{archBusy === 'approve' ? 'Approving…' : 'Approve & start implementation'}
                        </Button>
                      ) : (
                        <Button size="xs" onClick={finalizeArch} disabled={archBusy !== ''}>
                          <ArrowsRightLeftIcon className="size-3.5 mr-1" />{archBusy === 'finalize' ? 'Committing…' : 'Finalize & commit to main'}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* §phase-gates: the SUBMISSION gate. The code is done and pushed; Submit PR (top bar) opens the
                PR, or chat here to ask for changes first (code-refine makes them, re-verifies, returns here). */}
            {detail.run.status === 'ready_to_submit' && (
              <div className="mt-3 rounded-lg border border-[var(--amber-6)] bg-[var(--amber-2)] p-3">
                <span className="text-sm font-medium text-[var(--gray-12)]">📤 Ready to submit</span>
                <p className="text-xs text-[var(--gray-10)] mt-1">The code is complete and the branch is pushed. Use <strong>Submit PR</strong> above to open the pull request, or chat below to ask for more changes first — the agent will make them, re-run the checks, and return here.</p>
                <div className="mt-3">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Ask for changes before submitting, e.g. rename X or add a test…"
                    rows={2}
                    className="w-full rounded border border-[var(--gray-6)] bg-[var(--gray-1)] px-2 py-1 text-sm text-[var(--gray-12)]"
                  />
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <Button variant="soft" size="xs" onClick={send} disabled={!draft.trim()}>
                      <PaperAirplaneIcon className="size-3.5 mr-1" />Send changes to agent
                    </Button>
                    <Button size="xs" onClick={submitPr} disabled={submitting}>
                      <PaperAirplaneIcon className="size-3.5 mr-1" />{submitting ? 'Submitting…' : 'Submit PR'}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            <TestEnvPanel prs={detail.prs ?? []} projectId={detail.run.project_id} projectName={detail.run.project?.name} />

            {/* Live "working" strip — persistent while the run is live so progress is visible between
                turn-boundary transcript messages. Distinct queued (waiting) vs running (active) states,
                the latest live event promoted out of the collapsed block, and a freshness clock so a
                stalled run doesn't look identical to a healthy one. */}
            {liveStatus && (() => {
              const events = detail.events ?? [];
              const latest = events[events.length - 1];
              const queued = detail.run.status === 'queued';
              const ageSec = Math.max(0, Math.round((Date.now() - lastActivityRef.current) / 1000));
              const stale = !queued && ageSec >= 45;   // past the heartbeat window → possibly wedged
              return (
                <div className={`mb-3 rounded-md border px-3 py-2 flex items-center gap-3 ${
                  stale ? 'border-amber-300 bg-amber-50' : 'border-[var(--gray-6)] bg-[var(--gray-2)]'
                }`}>
                  <span className="relative flex size-2.5 shrink-0">
                    {!queued && !stale && <span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 animate-ping" />}
                    <span className={`relative inline-flex rounded-full size-2.5 ${queued ? 'bg-[var(--gray-8)]' : stale ? 'bg-amber-500' : 'bg-blue-500'}`} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-[var(--gray-12)]">
                      {queued ? 'Waiting for a worker to pick this up…' : phaseProse(detail.run.current_phase)}
                    </div>
                    {!queued && latest && (
                      <div className="text-xs text-[var(--gray-11)] truncate">{eventLabel(latest)}</div>
                    )}
                  </div>
                  {!queued && (
                    <span className={`shrink-0 text-[11px] tabular-nums ${stale ? 'text-amber-700 font-medium' : 'text-[var(--gray-10)]'}`}>
                      {stale ? `no activity for ${ageSec}s` : `updated ${ageSec}s ago`}
                    </span>
                  )}
                </div>
              );
            })()}

            {/* Transcript — one interactive, chronological timeline of the run (se_events + se_messages):
                agent prose (Markdown), tool steps, and file writes/edits as expandable document cards
                with diffs + Markdown preview, plus a live activity ticker. Scrolls only this container. */}
            <div className="relative flex flex-col flex-1 min-h-0">
              <div ref={transcript} onScroll={onTranscriptScroll} className="flex-1 min-h-0 overflow-y-auto">
                <div ref={content}>
                  <RunTimeline detail={detail} live={liveStatus} />
                </div>
              </div>
              {/* Return-to-live affordance — only while the user has scrolled away from the bottom. */}
              {!stickToBottom && (
                <button
                  type="button"
                  onClick={jumpToLatest}
                  className="absolute bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full border border-[var(--gray-6)] bg-[var(--gray-1)] px-3 py-1.5 text-xs font-medium text-[var(--gray-12)] shadow-md hover:bg-[var(--gray-3)]"
                >
                  <ArrowDownIcon className="size-3.5" />Jump to latest
                </button>
              )}
            </div>

            {/* Chat into the running agent */}
            <div className="mt-3 pt-3 border-t border-[var(--gray-5)]" onDrop={liveStatus ? onChatDrop : undefined} onDragOver={(e) => e.preventDefault()}>
              {chatAtts.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {chatAtts.map((a) => (
                    <div key={a.key} className="relative group">
                      {a.url
                        ? <img src={a.url} alt={a.name} className="h-14 w-14 rounded border object-cover" />
                        : <div className="h-14 w-14 rounded border flex items-center justify-center bg-[var(--gray-2)]"><LoadingSpinner /></div>}
                      <button type="button" onClick={() => removeChatAtt(a.key)} className="absolute -top-1.5 -right-1.5 rounded-full bg-[var(--gray-12)] text-[var(--gray-1)] size-4 leading-none text-[11px] opacity-0 group-hover:opacity-100" aria-label="Remove">×</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2 items-center">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
                  onPaste={liveStatus ? onChatPaste : undefined}
                  placeholder={liveStatus ? 'Message the agent…  (paste or drop a screenshot)' : 'Run is not live'}
                  disabled={!liveStatus}
                  className="flex-1 min-w-0 rounded-md border border-[var(--gray-6)] bg-transparent px-3 py-2 text-sm disabled:opacity-50"
                />
                <label className={`text-xs whitespace-nowrap ${liveStatus ? 'text-[var(--gray-10)] hover:text-[var(--gray-12)] cursor-pointer underline' : 'text-[var(--gray-8)] cursor-not-allowed'}`}>
                  Attach<input type="file" accept="image/*" multiple onChange={onChatPick} disabled={!liveStatus} className="hidden" />
                </label>
                <Button onClick={send} size="sm" disabled={!liveStatus || chatUploading || (!draft.trim() && !chatAtts.some((a) => a.url))}>
                  <PaperAirplaneIcon className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function IssuesView() {
  const [issues, setIssues] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<any>({ project_id: '', title: '', body: '', assign: true });
  const [creating, setCreating] = useState(false);
  const [atts, setAtts] = useState<any[]>([]);   // pasted/dropped screenshots → uploaded to `media`
  // Optimistic rows for just-created issues. GitHub's list endpoint is eventually consistent, so the
  // POST-response issue often isn't in the next `/issues` fetch yet — we render it immediately and
  // reconcile (drop it once the real fetch surfaces it, keyed by project+number).
  const [optimistic, setOptimistic] = useState<any[]>([]);
  const [showTriage, setShowTriage] = useState(false);

  const load = useCallback(async () => {
    try { setIssues((await api(`/issues${filter ? `?project=${filter}` : ''}`)).issues ?? []); setErr(null); }
    catch (e: any) { setErr(String(e.message ?? e)); } finally { setLoading(false); }
  }, [filter]);
  useEffect(() => { api('/projects').then((d) => { setProjects(d.projects ?? []); setForm((f: any) => ({ ...f, project_id: f.project_id || d.projects?.[0]?.id || '' })); }).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);

  // Live run-status badges: se_runs is in Supabase, so realtime keeps them current (mirrors RunsView).
  useEffect(() => {
    const ch = supabase.channel('se-issues-runs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'se_runs' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  // The issue list itself lives on GitHub (no push to this client), so poll it — but only while the
  // tab is visible, and refetch immediately on re-focus so a hidden tab doesn't go stale.
  useEffect(() => {
    const tick = () => { if (typeof document === 'undefined' || !document.hidden) load(); };
    const id = setInterval(tick, 20000);
    const onVis = () => { if (typeof document !== 'undefined' && !document.hidden) load(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  // Drop optimistic rows once the real (GitHub-backed) fetch surfaces them.
  useEffect(() => {
    if (!optimistic.length) return;
    setOptimistic((o) => pendingOptimistic(o, issues));
  }, [issues]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile after a create: refetch a few times with backoff to absorb GitHub's propagation lag.
  const reconcile = useCallback(async () => {
    for (const delay of [800, 1500, 2500, 4000]) {
      await new Promise((r) => setTimeout(r, delay));
      await load();
    }
  }, [load]);

  // Upload one image to the public `media` bucket and track it; GitHub renders its public URL inline.
  const uploadImage = async (file: File) => {
    if (!file.type.startsWith('image/')) return;
    if (file.size > 15 * 1024 * 1024) { setErr('image too large (max 15MB)'); return; }
    const key = crypto.randomUUID();
    const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
    const path = `se-issues/${form.project_id || 'unknown'}/${key}.${ext}`;
    setAtts((a) => [...a, { key, name: file.name || `${key}.${ext}`, url: '', uploading: true }]);
    try {
      const { error } = await supabase.storage.from('media').upload(path, file, { upsert: false, cacheControl: '3600', contentType: file.type });
      if (error) throw error;
      const { data } = supabase.storage.from('media').getPublicUrl(path);
      setAtts((a) => a.map((x) => (x.key === key ? { ...x, uploading: false, url: data.publicUrl } : x)));
    } catch (e: any) { setErr(`image upload failed: ${String(e.message ?? e)}`); setAtts((a) => a.filter((x) => x.key !== key)); }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData?.items ?? []).filter((it) => it.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    imgs.forEach((it) => { const f = it.getAsFile(); if (f) uploadImage(f); });
  };
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); Array.from(e.dataTransfer?.files ?? []).forEach(uploadImage); };
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => { Array.from(e.target.files ?? []).forEach(uploadImage); e.target.value = ''; };
  const removeAtt = (key: string) => setAtts((a) => a.filter((x) => x.key !== key));

  const uploading = atts.some((a) => a.uploading);
  const create = async () => {
    if (!form.project_id || !form.title.trim() || uploading) return;
    setCreating(true);
    const title = form.title.trim();
    const projectId = form.project_id;
    const assign = form.assign;
    try {
      const res = await api('/issues', { method: 'POST', body: JSON.stringify({
        project_id: projectId, title, body: form.body, assign_to_agent: assign,
        attachments: atts.filter((a) => a.url).map((a) => ({ url: a.url })),
      }) });
      // The server strips any attachment URL that isn't reachable over https by GitHub's image proxy
      // (the SSRF allowlist). On localhost the storage URL is http://…localhost, so it's dropped — warn
      // rather than showing a silent success. This is expected on localhost; it works in staging/prod.
      if (res?.attachmentsDropped > 0) {
        setErr(`${res.attachmentsDropped} image(s) couldn't be attached — the storage URL isn't publicly reachable over https (expected on localhost; works in staging/production).`);
      } else {
        setErr(null);
      }
      // Prepend an optimistic row from the server-returned identifiers (number/url/runId) so the new
      // issue shows instantly; hrefs come from the server, never from user input.
      if (res?.number) {
        const proj = projects.find((p) => p.id === projectId);
        setOptimistic((o) => [
          {
            project: { id: projectId, name: proj?.name, avatar_emoji: proj?.avatar_emoji },
            repo: '', number: res.number, title, url: res.url, labels: [], agent: assign,
            updated_at: new Date().toISOString(),
            run: res.runId ? { id: res.runId, status: 'queued' } : null,
            _optimistic: true,
          },
          ...o.filter((x) => !(x.number === res.number && x.project?.id === projectId)),
        ]);
      }
      setForm((f: any) => ({ ...f, title: '', body: '' })); setAtts([]);
      await load();
      reconcile();
    }
    catch (e: any) { setErr(String(e.message ?? e)); } finally { setCreating(false); }
  };

  // Render pending optimistic rows (not yet in the GitHub-backed list) above the real ones.
  const merged = mergeIssues(optimistic, issues);

  return (
    <div className="max-w-4xl space-y-4">
      {err && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">{err}</div>}
      <section className="rounded-lg border p-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">Report an issue</span>
          <button
            onClick={() => setShowTriage((v) => !v)}
            className={`ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${showTriage ? 'border-blue-400 text-blue-600' : 'border-[var(--gray-6)] text-[var(--gray-11)] hover:text-[var(--gray-12)]'}`}
          >
            <SparklesIcon className="size-4" aria-hidden /> AI triage
          </button>
        </div>
        {/* §10.5 triage copilot: converses, then prefills the form below — the human still reviews
            and presses Create (the copilot itself can't create issues). */}
        {showTriage && (
          <TriageCopilot
            projectId={form.project_id}
            onDraft={(d) => setForm((f: any) => ({ ...f, title: d.title, body: d.body, assign: d.assign_to_agent }))}
            attachments={atts}
            onUploadImage={uploadImage}
            onRemoveAttachment={removeAtt}
          />
        )}
        <div className="flex flex-col sm:flex-row gap-2">
          <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })} className="rounded-md border px-2 py-1.5 text-sm">
            {projects.map((p) => <option key={p.id} value={p.id}>{projectOptionLabel(p.avatar_emoji, p.name)}</option>)}
          </select>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Title" className="flex-1 min-w-0 rounded-md border px-3 py-1.5 text-sm" />
        </div>
        <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} onPaste={onPaste} onDrop={onDrop} onDragOver={(e) => e.preventDefault()} placeholder="Describe the problem or improvement…  (paste or drop a screenshot to attach)" rows={3} className="w-full rounded-md border px-3 py-2 text-sm" />
        {atts.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {atts.map((a) => (
              <div key={a.key} className="relative group">
                {a.url
                  ? <img src={a.url} alt={a.name} className="h-16 w-16 rounded border object-cover" />
                  : <div className="h-16 w-16 rounded border flex items-center justify-center bg-[var(--gray-2)]"><LoadingSpinner /></div>}
                <button type="button" onClick={() => removeAtt(a.key)} className="absolute -top-1.5 -right-1.5 rounded-full bg-[var(--gray-12)] text-[var(--gray-1)] size-4 leading-none text-[11px] opacity-0 group-hover:opacity-100" aria-label="Remove">×</button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={form.assign} onChange={(e) => setForm({ ...form, assign: e.target.checked })} className="size-4" />Hand to a software engineer agent</label>
            <label className="text-xs text-[var(--gray-10)] hover:text-[var(--gray-12)] cursor-pointer underline">
              Attach image<input type="file" accept="image/*" multiple onChange={onPick} className="hidden" />
            </label>
          </div>
          <Button size="sm" onClick={create} disabled={creating || uploading || !form.title.trim()}>{uploading ? 'Uploading…' : 'Create issue'}</Button>
        </div>
      </section>

      {projects.length > 1 && (
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-md border px-2 py-1.5 text-sm">
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{projectOptionLabel(p.avatar_emoji, p.name)}</option>)}
        </select>
      )}
      {loading ? <div className="p-8 flex justify-center"><LoadingSpinner /></div>
        : merged.length === 0 ? <div className="text-sm text-[var(--gray-11)] p-6 text-center">No open issues.</div>
        : (
          <div className="space-y-1.5">
            {merged.map((i) => (
              <div key={issueKey(i)} className="flex items-center justify-between rounded-md border p-2.5 gap-2">
                <div className="min-w-0">
                  <a href={i.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-[var(--gray-12)] hover:underline block truncate">{i.title}</a>
                  <div className="text-[11px] text-[var(--gray-10)] truncate flex items-center gap-1"><ProjectAvatar emoji={i.project?.avatar_emoji} className="size-3.5" /><span className="truncate">{i.project?.name} · {i.repo}#{i.number}</span></div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {i.run && <Badge color={STATUS_COLOR[i.run.status] ?? 'gray'} variant="soft" size="1">{i.run.status}{i.run.engineer_name ? ` · ${i.run.engineer_name}` : ''}</Badge>}
                  {i.agent && !i.run && <Badge color="blue" variant="soft" size="1">agent</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

const BASE = '/software-engineer';

export default function SoftwareEngineerTab() {
  const navigate = useNavigate();
  const location = useLocation();
  const { pathname } = location;

  // URL-driven so each tab + run have their own shareable URL:
  //   /software-engineer                → Overview (default landing)
  //   /software-engineer/runs           → Runs board
  //   /software-engineer/runs/<id>      → a specific run (deep-linkable)
  //   /software-engineer/issues         → Issues
  //   /software-engineer/setup          → Setup (first / current project)
  //   /software-engineer/setup/<id>     → Setup scoped to a specific project (deep-linkable)
  const m = pathname.match(/^\/software-engineer(?:\/(overview|setup|runs|issues)(?:\/([^/]+))?)?/);
  const section = m?.[1];
  const activeTab: 'overview' | 'runs' | 'issues' | 'setup' =
    section === 'runs' ? 'runs' : section === 'issues' ? 'issues' : section === 'setup' ? 'setup' : 'overview';
  const selectedRun = section === 'runs' ? (m?.[2] ?? null) : null;
  const selectedProject = section === 'setup' ? (m?.[2] ?? null) : null;

  const onTabChange = (t: string) => navigate(t === 'overview' ? BASE : `${BASE}/${t}`);
  // Setup's selected project lives in the path so each project has its own shareable URL.
  const onSelectProject = (id: string | null) => navigate(id ? `${BASE}/setup/${id}` : `${BASE}/setup`);
  // Preserve the query string (status / project filter) when selecting or deselecting a run so the
  // board's active filter survives opening a run and coming back.
  const onSelectRun = (id: string | null) =>
    navigate({ pathname: id ? `${BASE}/runs/${id}` : `${BASE}/runs`, search: location.search });
  // From an Overview KPI tile: open the Runs board filtered to a status set, carrying the tile's
  // project scope. Both values are our own (status from a fixed allowlist, project a UUID) — no user
  // free-text reaches the URL here.
  const onOpenRuns = (statusParam: string, project?: string) => {
    const p = new URLSearchParams();
    if (statusParam) p.set('status', statusParam);
    if (project) p.set('project', project);
    const qs = p.toString();
    navigate(`${BASE}/runs${qs ? `?${qs}` : ''}`);
  };

  return (
    <Page title="Software Engineer">
      <WorkspaceLayout
        title="Software Engineer"
        tabs={[
          { id: 'overview', label: 'Overview', icon: <ChartBarIcon className="size-4" /> },
          { id: 'runs', label: 'Runs', icon: <CommandLineIcon className="size-4" /> },
          { id: 'issues', label: 'Issues', icon: <ClipboardDocumentListIcon className="size-4" /> },
          { id: 'setup', label: 'Setup', icon: <Cog6ToothIcon className="size-4" /> },
        ]}
        activeTabId={activeTab}
        onTabChange={onTabChange}
      >
        <div className="py-6">
          {activeTab === 'overview' && <OverviewView onGoToSetup={() => onTabChange('setup')} onOpenRuns={onOpenRuns} />}
          {activeTab === 'runs' && <RunsView selected={selectedRun} onSelect={onSelectRun} onGoToSetup={() => onTabChange('setup')} />}
          {activeTab === 'issues' && <IssuesView />}
          {activeTab === 'setup' && <SetupPanel routeProjectId={selectedProject} onSelectProject={onSelectProject} />}
        </div>
      </WorkspaceLayout>
    </Page>
  );
}
