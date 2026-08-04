// @ts-nocheck
/**
 * Software Engineer setup: PROJECTS per brand. A project is the persistent unit — it holds ALL
 * credentials (GitHub PAT + Claude model credential), its repos, shared memory, policy, and a
 * concurrency cap. Engineers are ephemeral (spawned per issue). Credentials are entered as plaintext,
 * sealed server-side; only last-4 is shown back. Commits are authored as the PAT owner (read-only).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Badge, Button } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { toast } from 'sonner';
import { CommandLineIcon, KeyIcon, ShieldCheckIcon, PlusIcon, TrashIcon, FolderPlusIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import MemoryReviewSection from './MemoryReviewSection';

const API = '/api/modules/software-engineer/admin';

async function api(path: string, init?: RequestInit) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const r = await fetch(`${API}${path}`, {
    ...init, credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}

const inputCls = 'w-full rounded-md border px-3 py-2 text-sm';
const Field = ({ label, children }: { label: React.ReactNode; children: React.ReactNode }) => (
  // Label stacks above the input on phones; fixed-label two-column grid from sm up.
  <div className="grid grid-cols-1 sm:grid-cols-[200px_1fr] sm:items-center gap-1 sm:gap-3 py-1.5">
    <span className="text-sm text-[var(--gray-11)]">{label}</span>{children}
  </div>
);
const Section = ({ icon, title, children }: any) => (
  <section className="rounded-lg border p-4 space-y-1">
    <div className="flex items-center gap-2 font-medium mb-2">{icon}{title}</div>{children}
  </section>
);

// "Update staging" — deployment-optional (renders only where the operator
// wired a /staging-control channel; see api/admin-routes.ts). Triggers the
// host-side drain-aware update cycle: module repos fast-forward, services
// restart, and the SE runner restarts only once its queue is idle — active
// runs pause between phases, they are never killed. Super-admin only
// (server-enforced).
const ACTIVE_STATES = new Set(['pulling', 'restarting-services', 'draining-se', 'restarting-se-runner', 'rebuilding-admin']);
function StagingUpdateSection() {
  const [info, setInfo] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api('/staging-update/status').then(setInfo).catch(() => setInfo(null));
  }, []);
  const active = !!info && (info.pending || ACTIVE_STATES.has(info.status?.state));
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [active, load]);
  if (!info?.available) return null;
  const trigger = async () => {
    setBusy(true);
    try {
      await api('/staging-update', { method: 'POST' });
      toast.success('Staging update requested — SE runner restarts once its queue drains');
      load();
    } catch (e: any) {
      toast.error(/403/.test(String(e?.message)) ? 'Super-admin access required' : `Update request failed: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  };
  const st = info.status;
  return (
    <Section icon={<ArrowPathIcon className="size-5" />} title="Staging deployment">
      <p className="text-xs text-neutral-500 mb-2">
        Pulls the latest merged module code onto this instance and restarts services.
        Active SE runs are never killed — the runner restarts only between agent phases, once its queue is idle.
      </p>
      {st && (
        <div className="text-sm mb-2 flex items-center gap-2">
          <Badge color={st.state === 'done' ? 'green' : st.state === 'error' ? 'red' : 'blue'}>{info.pending && !ACTIVE_STATES.has(st.state) ? 'queued' : st.state}</Badge>
          <span className="text-neutral-500 text-xs">{st.detail}</span>
        </div>
      )}
      {!st && info.pending && <div className="text-sm mb-2"><Badge color="blue">queued</Badge></div>}
      <Button size="sm" onClick={trigger} disabled={busy || active}>
        <ArrowPathIcon className={`size-4 mr-1 ${active ? 'animate-spin' : ''}`} />
        {active ? 'Update in progress…' : 'Update staging'}
      </Button>
    </Section>
  );
}

export default function SetupPanel(
  { routeProjectId, onSelectProject }: { routeProjectId?: string | null; onSelectProject?: (id: string | null) => void } = {},
) {
  const [brands, setBrands] = useState<any[]>([]);
  const [site, setSite] = useState('');
  const [projects, setProjects] = useState<any[]>([]);
  const [pid, setPid] = useState('');
  const [s, setS] = useState<any>({});
  const [repos, setRepos] = useState<any[]>([]);
  const [ghToken, setGhToken] = useState('');
  const [modelCred, setModelCred] = useState('');
  const [mcpConfig, setMcpConfig] = useState('');
  const [skills, setSkills] = useState('');
  const [newProj, setNewProj] = useState({ name: '', emoji: '' });
  const [newRepo, setNewRepo] = useState({ owner: '', name: '' });
  const [msg, setMsg] = useState<{ ok?: boolean; text: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/brands').then((d) => { setBrands(d.brands ?? []); if (!site && d.brands?.[0]) setSite(d.brands[0].id); })
      .catch((e) => setMsg({ text: String(e.message ?? e) })).finally(() => setLoading(false));
  }, []);

  // Single-tenant: one flat project list for the instance (sites are websites, not tenants).
  const loadProjects = useCallback(async (selectId?: string) => {
    try {
      const d = await api('/projects');
      const list = d.projects ?? [];
      setProjects(list);
      // Selection priority: explicit selectId, then the /setup/<projectId> URL, then the
      // currently-selected project, then the first project.
      setPid(selectId ?? routeProjectId ?? (list.find((x: any) => x.id === pid)?.id) ?? list[0]?.id ?? '');
    } catch (e: any) { setMsg({ text: String(e.message ?? e) }); }
  }, [pid, routeProjectId]);
  useEffect(() => { loadProjects(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The URL (/software-engineer/setup/<projectId>) is the source of truth for which project is
  // selected, so a per-project setup page is deep-linkable and shareable.
  useEffect(() => { if (routeProjectId && routeProjectId !== pid) setPid(routeProjectId); }, [routeProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Select a project by navigating (URL-driven) when the router wiring is present; otherwise fall
  // back to local state so the panel still works if mounted standalone.
  const selectProject = useCallback((id: string | null) => {
    if (onSelectProject) onSelectProject(id);
    else setPid(id ?? '');
  }, [onSelectProject]);

  const loadProject = useCallback(async (id: string) => {
    if (!id) { setS({}); setRepos([]); return; }
    try {
      const [d, rp] = await Promise.all([api(`/projects/${id}`), api(`/projects/${id}/repos`)]);
      setS(d.project ?? {}); setRepos(rp.repos ?? []); setGhToken(''); setModelCred(''); setMcpConfig('');
      setSkills(Array.isArray(d.project?.skills) && d.project.skills.length ? JSON.stringify(d.project.skills, null, 2) : '');
    } catch (e: any) { setMsg({ text: String(e.message ?? e) }); }
  }, []);
  useEffect(() => { loadProject(pid); }, [pid, loadProject]);

  const set = (k: string) => (e: any) => setS((p: any) => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const addProject = async () => {
    if (!newProj.name.trim() || !site) return;
    try {
      const d = await api('/projects', { method: 'POST', body: JSON.stringify({ site_id: site, name: newProj.name.trim(), avatar_emoji: newProj.emoji.trim() || null }) });
      setNewProj({ name: '', emoji: '' }); await loadProjects(d.id); selectProject(d.id);
    } catch (e: any) { setMsg({ text: String(e.message ?? e) }); }
  };
  const deleteProject = async () => {
    if (!pid || !window.confirm(`Delete project "${s.name}"? Its repos + credentials are removed; runs detach.`)) return;
    try { await api(`/projects/${pid}`, { method: 'DELETE' }); setPid(''); await loadProjects(); selectProject(null); }
    catch (e: any) { setMsg({ text: String(e.message ?? e) }); }
  };

  const save = async () => {
    setMsg(null);
    const body: any = {
      name: s.name, description: s.description ?? null, avatar_emoji: s.avatar_emoji ?? null,
      issues_repo_owner: s.issues_repo_owner?.trim() || null, issues_repo_name: s.issues_repo_name?.trim() || null,
      trigger_label: s.trigger_label?.trim() || 'agent:build',
      primary_instance_id: s.primary_instance_id?.trim() || null,
      max_code_repos_per_run: s.max_code_repos_per_run ? Number(s.max_code_repos_per_run) : 3,
      github_token_kind: s.github_token_kind, model_cred_kind: s.model_cred_kind, model: s.model,
      commit_author_name: s.commit_author_name?.trim() || null, commit_author_email: s.commit_author_email?.trim() || null,
      autonomy_mode: s.autonomy_mode, intake_enabled: !!s.intake_enabled,
      max_concurrent_engineers: s.max_concurrent_engineers ? Number(s.max_concurrent_engineers) : 2,
      max_interactive_engineers: s.max_interactive_engineers ? Number(s.max_interactive_engineers) : 1,
      allowed_labellers: (typeof s.allowed_labellers === 'string' ? s.allowed_labellers.split(',').map((x: string) => x.trim()).filter(Boolean) : s.allowed_labellers) ?? [],
      monthly_token_budget: s.monthly_token_budget ? Number(s.monthly_token_budget) : null,
      per_run_token_ceiling: s.per_run_token_ceiling ? Number(s.per_run_token_ceiling) : null,
      per_run_wallclock_minutes: s.per_run_wallclock_minutes ? Number(s.per_run_wallclock_minutes) : null,
    };
    if (ghToken.trim()) body.github_token = ghToken.trim();
    if (modelCred.trim()) body.model_cred = modelCred.trim();
    // MCP config: send only when the operator typed something. A literal "clear" empties it.
    if (mcpConfig.trim()) body.mcp_config = mcpConfig.trim() === 'clear' ? null : mcpConfig.trim();
    // Skills: a JSON array of { repo, path, ref }. Blank = clear. Parse client-side to catch typos
    // early; the server re-validates every entry through parseSkillsConfig before persisting.
    if (skills.trim() === '') { body.skills = []; }
    else {
      let parsed: unknown;
      try { parsed = JSON.parse(skills); } catch { toast.error('Skills must be valid JSON (an array of { repo, path, ref }).'); return; }
      if (!Array.isArray(parsed)) { toast.error('Skills must be a JSON array.'); return; }
      body.skills = parsed;
    }
    try { await api(`/projects/${pid}`, { method: 'PUT', body: JSON.stringify(body) }); toast.success('Project saved'); await loadProjects(); await loadProject(pid); }
    catch (e: any) { toast.error(String(e.message ?? e)); }
  };
  const addRepo = async () => {
    if (!newRepo.owner.trim() || !newRepo.name.trim() || !pid) return;
    try { await api(`/projects/${pid}/repos`, { method: 'POST', body: JSON.stringify({ repo_owner: newRepo.owner.trim(), repo_name: newRepo.name.trim() }) }); setNewRepo({ owner: '', name: '' }); await loadProject(pid); }
    catch (e: any) { setMsg({ text: String(e.message ?? e) }); }
  };
  const toggleRepo = async (r: any) => patchRepo(r, { enabled: !r.enabled });
  const patchRepo = async (r: any, patch: any) => { try { await api(`/projects/${pid}/repos/${r.id}`, { method: 'PATCH', body: JSON.stringify(patch) }); await loadProject(pid); } catch (e: any) { setMsg({ text: String(e.message ?? e) }); } };
  const delRepo = async (r: any) => { if (!window.confirm(`Remove ${r.repo_owner}/${r.repo_name}?`)) return; try { await api(`/projects/${pid}/repos/${r.id}`, { method: 'DELETE' }); await loadProject(pid); } catch (e: any) { setMsg({ text: String(e.message ?? e) }); } };

  if (loading) return <div className="p-8 flex justify-center"><LoadingSpinner /></div>;

  const commitsAs = s.commit_author_name?.trim()
    ? `${s.commit_author_name} <${s.commit_author_email || '—'}>`
    : (s.github_user_login ? `${s.github_user_name || s.github_user_login} <${s.github_user_id}+${s.github_user_login}@users.noreply.github.com>` : 'derived from the GitHub token on first run');

  return (
    <div className="max-w-4xl space-y-5">
      {msg && <div className={`rounded-md border p-2 text-sm ${msg.ok ? 'border-green-300 bg-green-50 text-green-800' : 'border-red-300 bg-red-50 text-red-800'}`}>{msg.text}</div>}

      <div className="flex flex-col lg:flex-row gap-5">
        <div className="w-full lg:w-64 shrink-0 space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--gray-10)]">Projects</div>
          {projects.length === 0 && <div className="text-sm text-[var(--gray-11)]">No projects yet.</div>}
          {projects.map((p) => (
            <button key={p.id} onClick={() => selectProject(p.id)}
              className={`block w-full text-left rounded-md px-3 py-2 border transition-colors ${pid === p.id ? 'border-[var(--gray-6)] bg-[var(--gray-3)]' : 'border-transparent hover:bg-[var(--gray-2)]'}`}>
              <div className="text-sm font-medium text-[var(--gray-12)] flex items-center gap-2"><span>{p.avatar_emoji || '📁'}</span>{p.name}</div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <Badge color={p.intake_enabled ? 'green' : 'gray'} variant="soft" size="1">{p.intake_enabled ? 'active' : 'off'}</Badge>
                <span className="text-[11px] text-[var(--gray-10)]">max {p.max_concurrent_engineers ?? 2}{p.github_user_login ? ` · @${p.github_user_login}` : ''}</span>
              </div>
            </button>
          ))}
          <div className="rounded-md border border-dashed p-2 space-y-2">
            <input placeholder="New project name" value={newProj.name} onChange={(e) => setNewProj({ ...newProj, name: e.target.value })} className="w-full rounded-md border px-2 py-1.5 text-sm" />
            <div className="flex gap-2">
              <input placeholder="📁" value={newProj.emoji} onChange={(e) => setNewProj({ ...newProj, emoji: e.target.value })} className="w-14 rounded-md border px-2 py-1.5 text-sm text-center" />
              <Button variant="soft" size="sm" onClick={addProject} className="flex-1"><FolderPlusIcon className="size-4 mr-1" />Create</Button>
            </div>
          </div>
        </div>

        <div className="flex-1 min-w-0 space-y-4">
          {!pid ? (
            <div className="text-sm text-[var(--gray-11)] p-8 text-center">Select or create a project to configure.</div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <input value={s.name ?? ''} onChange={set('name')} className="text-lg font-semibold bg-transparent border-b border-transparent focus:border-[var(--gray-6)] outline-none" />
                <Button variant="ghost" color="red" size="xs" onClick={deleteProject}><TrashIcon className="size-4 mr-1" />Delete</Button>
              </div>

              <Section icon={<KeyIcon className="size-4" />} title="GitHub (project credentials)">
                <Field label="Token kind">
                  <select value={s.github_token_kind ?? 'pat'} onChange={set('github_token_kind')} className={inputCls}>
                    <option value="pat">PAT (fine-grained recommended)</option>
                    <option value="app">GitHub App installation</option>
                  </select>
                </Field>
                <Field label={<>Token {s.github_token_last4 ? <span className="text-neutral-400">(••••{s.github_token_last4})</span> : <span className="text-neutral-400">(unset)</span>}</>}>
                  {/* Suppress browser/password-manager autofill: a manager filling this field would
                      silently overwrite the pasted PAT with an unrelated stored credential. */}
                  <input type="password" placeholder="paste to replace" value={ghToken} onChange={(e) => setGhToken(e.target.value)} className={inputCls}
                    autoComplete="new-password" name="se-github-token" spellCheck={false}
                    data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other" />
                </Field>
                <Field label="Health"><Badge color={s.github_health === 'ok' ? 'green' : s.github_health === 'failing' ? 'red' : 'gray'} variant="soft">{s.github_health ?? 'unknown'}</Badge></Field>
                <Field label="Commits authored as"><span className="text-sm text-[var(--gray-12)]">{commitsAs}</span></Field>
                <p className="text-xs text-[var(--gray-10)] pt-1">Commits + PRs are authored by the PAT owner, so they read as their own local work — engineers are ephemeral and not named in git. Override the author below if needed.</p>
                <Field label="Author override (name)"><input value={s.commit_author_name ?? ''} onChange={set('commit_author_name')} placeholder="(optional — defaults to token owner)" className={inputCls} /></Field>
                <Field label="Author override (email)"><input value={s.commit_author_email ?? ''} onChange={set('commit_author_email')} placeholder="(optional)" className={inputCls} /></Field>
              </Section>

              <Section icon={<CommandLineIcon className="size-4" />} title="Claude model credential (project)">
                <Field label="Kind">
                  <select value={s.model_cred_kind ?? 'anthropic_api_key'} onChange={set('model_cred_kind')} className={inputCls}>
                    <option value="anthropic_api_key">Anthropic API key</option>
                    <option value="claude_code_oauth_token">Claude Code OAuth token (subscription)</option>
                    <option value="bedrock">AWS Bedrock</option>
                    <option value="vertex">Google Vertex</option>
                  </select>
                </Field>
                <Field label={<>Credential {s.model_cred_last4 ? <span className="text-neutral-400">(••••{s.model_cred_last4})</span> : <span className="text-neutral-400">(unset)</span>}</>}>
                  {/* Suppress browser/password-manager autofill (see the GitHub token field above). */}
                  <input type="password" placeholder="paste to replace" value={modelCred} onChange={(e) => setModelCred(e.target.value)} className={inputCls}
                    autoComplete="new-password" name="se-model-cred" spellCheck={false}
                    data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other" />
                </Field>
                <Field label="Model"><input value={s.model ?? 'claude-opus-4-8'} onChange={set('model')} className={inputCls} /></Field>
              </Section>

              <Section icon={<KeyIcon className="size-4" />} title="Work source (issues repo)">
                <Field label="Issues repo owner"><input value={s.issues_repo_owner ?? ''} onChange={set('issues_repo_owner')} placeholder="e.g. danthebaker" className={inputCls} /></Field>
                <Field label="Issues repo name"><input value={s.issues_repo_name ?? ''} onChange={set('issues_repo_name')} placeholder="e.g. gatewaze-roadmap" className={inputCls} /></Field>
                <Field label="Trigger label"><input value={s.trigger_label ?? 'agent:build'} onChange={set('trigger_label')} className={inputCls} /></Field>
                <Field label="Max code repos / run"><input type="number" min="1" value={s.max_code_repos_per_run ?? 3} onChange={set('max_code_repos_per_run')} className={inputCls} /></Field>
                <Field label="Primary instance id"><input value={s.primary_instance_id ?? ''} onChange={set('primary_instance_id')} placeholder="(optional — SE_INSTANCE_ID that owns unqualified trigger)" className={inputCls} /></Field>
                <p className="text-xs text-[var(--gray-10)] pt-1">Issues labelled <code className="font-mono text-[11px]">{s.trigger_label || 'agent:build'}</code> in this repo start runs; the agent works in the <em>code repos</em> below. Route to a specific instance with <code className="font-mono text-[11px]">{(s.trigger_label || 'agent:build')}@&lt;instance&gt;</code>.</p>
              </Section>

              <Section icon={<ShieldCheckIcon className="size-4" />} title="Behaviour + concurrency">
                <Field label="Max concurrent engineers"><input type="number" min="1" value={s.max_concurrent_engineers ?? 2} onChange={set('max_concurrent_engineers')} className={inputCls} /></Field>
                <Field label="Max interactive sessions"><input type="number" min="1" value={s.max_interactive_engineers ?? 1} onChange={set('max_interactive_engineers')} className={inputCls} /></Field>
                <Field label="Autonomy">
                  <select value={s.autonomy_mode ?? 'pr_only'} onChange={set('autonomy_mode')} className={inputCls}>
                    <option value="pr_only">PR only (never auto-merge)</option>
                    <option value="auto_merge_safe">Auto-merge safe changes</option>
                  </select>
                </Field>
                <Field label="Allowed labellers"><input placeholder="comma-separated GitHub logins" value={Array.isArray(s.allowed_labellers) ? s.allowed_labellers.join(', ') : (s.allowed_labellers ?? '')} onChange={set('allowed_labellers')} className={inputCls} /></Field>
                <Field label="Per-run token ceiling"><input type="number" value={s.per_run_token_ceiling ?? ''} onChange={set('per_run_token_ceiling')} className={inputCls} /></Field>
                <Field label="Per-run wall-clock (min)"><input type="number" value={s.per_run_wallclock_minutes ?? ''} onChange={set('per_run_wallclock_minutes')} className={inputCls} /></Field>
                <Field label="Monthly token budget"><input type="number" value={s.monthly_token_budget ?? ''} onChange={set('monthly_token_budget')} className={inputCls} /></Field>
                <Field label="Intake enabled (kill switch)"><label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={!!s.intake_enabled} onChange={set('intake_enabled')} className="size-4" />{s.intake_enabled ? 'On' : 'Off'}</label></Field>
              </Section>

              <Section icon={<CommandLineIcon className="size-4" />} title="Connected tools (MCP)">
                <Field label={<>Server config {s.has_mcp_config ? <span className="text-[var(--green-11)]">(configured)</span> : <span className="text-neutral-400">(none)</span>}</>}>
                  <textarea
                    rows={5}
                    placeholder={'{\n  "servers": {\n    "jira": { "type": "http", "url": "https://…/mcp", "headers": { "Authorization": "Bearer …" } }\n  }\n}'}
                    value={mcpConfig}
                    onChange={(e) => setMcpConfig(e.target.value)}
                    className={inputCls + ' font-mono text-[11px]'}
                  />
                </Field>
                <p className="text-xs text-[var(--gray-10)] pt-1">SDK-shaped <code className="font-mono text-[11px]">{'{ servers: { name: { type, url, headers } } }'}</code>, sealed on save (it carries bearer tokens). Exposed to every engineer on this project alongside the default Gatewaze MCP (<code className="font-mono text-[11px]">SE_DEFAULT_MCP_URL</code>). Type <code className="font-mono text-[11px]">clear</code> then Save to remove. Leave blank to keep the current config.</p>
              </Section>

              <Section icon={<CommandLineIcon className="size-4" />} title="Skills">
                <Field label={<>Skill sources {Array.isArray(s.skills) && s.skills.length ? <span className="text-[var(--green-11)]">({s.skills.length} configured)</span> : <span className="text-neutral-400">(none)</span>}</>}>
                  <textarea
                    rows={5}
                    placeholder={'[\n  { "repo": "gatewaze/gatewaze-skills", "path": "plugins/gatewaze-skills", "ref": "main" }\n]'}
                    value={skills}
                    onChange={(e) => setSkills(e.target.value)}
                    className={inputCls + ' font-mono text-[11px]'}
                  />
                </Field>
                <p className="text-xs text-[var(--gray-10)] pt-1">JSON array of <code className="font-mono text-[11px]">{'{ repo, path, ref }'}</code>. Each is a git repo the runner clones (with this project's PAT) and loads as a local Claude plugin — its skills/hooks become available to every engineer on this project. <code className="font-mono text-[11px]">path</code> points at the plugin dir inside the repo (default: repo root); <code className="font-mono text-[11px]">ref</code> defaults to <code className="font-mono text-[11px]">main</code>. Leave blank for none.</p>
              </Section>

              <div className="flex justify-end border-t border-[var(--gray-5)] pt-4">
                <Button onClick={save}>Save project</Button>
              </div>

              <MemoryReviewSection projectId={pid} onMessage={setMsg} />

              <StagingUpdateSection />

              <section className="rounded-lg border p-4">
                <div className="font-medium mb-1">Code repos</div>
                <p className="text-xs text-neutral-500 mb-3">The repos the agent works in (writable = it may change + open a PR; read-only = context only). Runs are triggered from the <em>issues repo</em> above, not here.</p>
                {repos.length === 0 && <div className="text-sm text-neutral-400 mb-3">No repos yet.</div>}
                <div className="space-y-1.5">
                  {repos.map((r) => (
                    <div key={r.id} className="flex flex-wrap items-center justify-between border-b py-1.5 last:border-0 gap-2">
                      <span className="font-mono text-sm truncate">{r.repo_owner}/{r.repo_name}</span>
                      <span className="flex flex-wrap items-center justify-end gap-2 text-xs shrink-0">
                        <select value={r.write_mode ?? 'writable'} onChange={(e) => patchRepo(r, { write_mode: e.target.value })} className="rounded border px-1 py-0.5 text-xs">
                          <option value="writable">writable</option>
                          <option value="read_only">read-only</option>
                        </select>
                        <input defaultValue={r.base_branch ?? ''} onBlur={(e) => { if ((e.target.value || null) !== (r.base_branch ?? null)) patchRepo(r, { base_branch: e.target.value || null }); }} placeholder="base" className="w-20 rounded border px-1 py-0.5 text-xs" />
                        <label className="inline-flex items-center gap-1"><input type="checkbox" checked={r.enabled} onChange={() => toggleRepo(r)} className="size-3.5" />on</label>
                        <Button variant="ghost" color="red" size="xs" onClick={() => delRepo(r)}><TrashIcon className="size-4" /></Button>
                      </span>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <input placeholder="owner" value={newRepo.owner} onChange={(e) => setNewRepo({ ...newRepo, owner: e.target.value })} className="flex-1 min-w-[7rem] sm:flex-none sm:w-40 rounded-md border px-3 py-2 text-sm" />
                  <span className="text-neutral-400">/</span>
                  <input placeholder="repo" value={newRepo.name} onChange={(e) => setNewRepo({ ...newRepo, name: e.target.value })} className="flex-1 min-w-[7rem] sm:flex-none sm:w-52 rounded-md border px-3 py-2 text-sm" />
                  <Button variant="soft" size="sm" onClick={addRepo}><PlusIcon className="size-4 mr-1" />Add repo</Button>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
