/**
 * AI Recipes — admin tab for managing git-driven Goose recipes.
 *
 * Per spec-ai-workflows-and-skill-interop.md §5 + §10.1. Mounted as a
 * tab inside the consolidated AI dashboard at /admin/ai.
 *
 * Surface in this commit:
 *   - List recipe sources (label, git URL, last sync, status).
 *   - Add a new source (modal: label, git URL, branch, path_prefix,
 *     optional auth token, webhook provider).
 *   - Per-row actions: Sync now, View (toggles details + parsed recipes
 *     list from that source), Delete.
 *   - Cross-source recipe list with a Run button per recipe.
 *   - Run-detail modal showing per-step provider/model/cost/duration
 *     and the final output.
 *
 * Not in this commit (follow-ups noted inline):
 *   - Webhook URL + secret reveal (mirror the skill-sources surface
 *     once the team agrees the same UX is right).
 *   - Recent webhook-event log panel.
 *   - Inline YAML-paste runner (the API endpoint exists; future UI).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';

import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Modal, Button, Badge } from '@/components/ui';

import {
  RecipesService,
  type RecipeFull,
  type RecipeListItem,
  type RecipeRun,
  type RecipeSource,
} from '../utils/recipesService';

const STATUS_COLOURS: Record<RecipeSource['sync_status'], string> = {
  pending: 'text-neutral-500',
  syncing: 'text-blue-500',
  ok: 'text-green-600',
  error: 'text-red-600',
};

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'in the future';
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

function microUsd(n: number): string {
  if (!n) return '$0.00';
  const usd = n / 1_000_000;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

export default function AiRecipesAdmin() {
  const [sources, setSources] = useState<RecipeSource[]>([]);
  const [recipes, setRecipes] = useState<RecipeListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSource, setExpandedSource] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [runOpen, setRunOpen] = useState<RecipeListItem | null>(null);
  const [runResult, setRunResult] = useState<RecipeRun | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [s, r] = await Promise.all([
      RecipesService.listSources(),
      RecipesService.listRecipes({ parse_status: 'all' }),
    ]);
    setLoading(false);
    if (!s.ok) {
      toast.error(`Failed to load recipe sources: ${s.error.message}`);
    } else {
      setSources(s.value);
    }
    if (!r.ok) {
      toast.error(`Failed to load recipes: ${r.error.message}`);
    } else {
      setRecipes(r.value);
    }
  }, []);

  useEffect(() => {
    void load();
    // Poll every 30s so sync status flips visibly when workers finish.
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const recipesBySource = useMemo(() => {
    const m = new Map<string, RecipeListItem[]>();
    for (const r of recipes) {
      const arr = m.get(r.source_id) ?? [];
      arr.push(r);
      m.set(r.source_id, arr);
    }
    return m;
  }, [recipes]);

  return (
    <div className="space-y-6">
      <p className="text-sm text-neutral-500">
        Git-driven Goose recipes. Each registered source is cloned and re-walked
        every 5 minutes (or instantly via webhook). Recipes that pass the
        portability tiers land in <code>ai_recipes</code> and can be executed
        with the Run button below.
      </p>

      {/* ── Sources ─────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium">Recipe sources</h2>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <PlusIcon className="size-4 mr-1" />
            Add source
          </Button>
        </div>
        {loading && sources.length === 0 ? (
          <div className="p-8 flex justify-center"><LoadingSpinner /></div>
        ) : sources.length === 0 ? (
          <div className="rounded-md border border-dashed p-10 text-center text-sm text-neutral-500">
            No recipe sources registered. Add one to start indexing Goose recipes.
          </div>
        ) : (
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50">
                <tr className="text-left">
                  <th className="px-3 py-2 w-8"></th>
                  <th className="px-3 py-2">Label</th>
                  <th className="px-3 py-2">Git URL</th>
                  <th className="px-3 py-2">Branch / path</th>
                  <th className="px-3 py-2">Last sync</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 w-32 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => {
                  const expanded = expandedSource === s.id;
                  const recs = recipesBySource.get(s.id) ?? [];
                  return (
                    <SourceRow
                      key={s.id}
                      source={s}
                      expanded={expanded}
                      recipes={recs}
                      onToggle={() => setExpandedSource(expanded ? null : s.id)}
                      onSync={async () => {
                        const r = await RecipesService.syncSource(s.id);
                        if (!r.ok) {
                          toast.error(`Sync failed: ${r.error.message}`);
                          return;
                        }
                        toast.success('Sync queued');
                        void load();
                      }}
                      onDelete={async () => {
                        if (!window.confirm(`Delete recipe source "${s.label}"? Indexed recipes for this source will be removed.`)) {
                          return;
                        }
                        const r = await RecipesService.deleteSource(s.id);
                        if (!r.ok) {
                          toast.error(`Delete failed: ${r.error.message}`);
                          return;
                        }
                        toast.success(`Deleted (${r.value.cascaded_recipe_count} recipes removed)`);
                        void load();
                      }}
                      onTest={async () => {
                        const r = await RecipesService.testConnection(s.id);
                        if (!r.ok) {
                          toast.error(`Test failed: ${r.error.message}`);
                          return;
                        }
                        if (r.value.ok) {
                          toast.success(`Connection OK (HEAD ${r.value.head_sha.slice(0, 7)})`);
                        } else {
                          toast.error(`Connection failed: ${r.value.error}`);
                        }
                      }}
                      onRunRecipe={(recipe) => setRunOpen(recipe)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── All recipes (cross-source flat list) ────────────────────── */}
      {recipes.length > 0 && (
        <section>
          <h2 className="text-sm font-medium mb-2">
            All recipes ({recipes.filter((r) => r.parse_status === 'ok').length} runnable / {recipes.length} total)
          </h2>
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50">
                <tr className="text-left">
                  <th className="px-3 py-2">Title</th>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Path</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 w-12 text-right"></th>
                </tr>
              </thead>
              <tbody>
                {recipes.map((r) => (
                  <tr key={r.id} className="border-t hover:bg-neutral-50">
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.title}</div>
                      {r.description && (
                        <div className="text-xs text-neutral-500 truncate max-w-md">{r.description}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-500">{r.source_label}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.file_path}</td>
                    <td className="px-3 py-2 text-xs">
                      <StatusBadge status={r.parse_status} />
                      {r.has_sub_recipes && (
                        <span className="ml-2 text-neutral-500">+ sub-recipes</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setRunOpen(r)}
                        disabled={r.parse_status !== 'ok'}
                        title={r.parse_status === 'ok' ? 'Run' : `Cannot run — parse_status=${r.parse_status}`}
                        className="inline-flex items-center px-2 py-1 rounded text-xs bg-blue-600 text-white disabled:opacity-40"
                      >
                        <PlayIcon className="size-3 mr-1" />
                        Run
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {addOpen && (
        <AddSourceModal
          onClose={() => setAddOpen(false)}
          onCreated={() => {
            setAddOpen(false);
            void load();
          }}
        />
      )}

      {runOpen && (
        <RunRecipeModal
          recipe={runOpen}
          onClose={() => {
            setRunOpen(null);
            setRunResult(null);
          }}
          onRan={setRunResult}
          runResult={runResult}
        />
      )}
    </div>
  );
}

// ─── Source row ─────────────────────────────────────────────────────

function SourceRow({
  source,
  expanded,
  recipes,
  onToggle,
  onSync,
  onDelete,
  onTest,
  onRunRecipe,
}: {
  source: RecipeSource;
  expanded: boolean;
  recipes: RecipeListItem[];
  onToggle: () => void;
  onSync: () => void;
  onDelete: () => void;
  onTest: () => void;
  onRunRecipe: (r: RecipeListItem) => void;
}) {
  return (
    <>
      <tr className="border-t hover:bg-neutral-50">
        <td className="px-3 py-2">
          <button type="button" onClick={onToggle} className="text-neutral-500">
            {expanded ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
          </button>
        </td>
        <td className="px-3 py-2 font-medium">{source.label}</td>
        <td className="px-3 py-2 font-mono text-xs">{source.git_url}</td>
        <td className="px-3 py-2 text-xs">
          <span className="font-mono">{source.branch}</span>
          {source.path_prefix && <span className="text-neutral-500"> / {source.path_prefix}</span>}
        </td>
        <td className="px-3 py-2 text-xs text-neutral-500">
          {timeAgo(source.last_synced_at)}
          {source.last_synced_commit && (
            <span className="ml-2 font-mono">{source.last_synced_commit.slice(0, 7)}</span>
          )}
        </td>
        <td className={`px-3 py-2 text-xs ${STATUS_COLOURS[source.sync_status]}`}>
          {source.sync_status === 'error' ? (
            <span title={source.sync_error ?? ''} className="inline-flex items-center gap-1">
              <ExclamationTriangleIcon className="size-3" />
              error
            </span>
          ) : (
            source.sync_status
          )}
        </td>
        <td className="px-3 py-2 text-right space-x-1">
          <button
            type="button"
            onClick={onTest}
            className="text-xs text-neutral-600 hover:underline"
            title="git ls-remote"
          >
            Test
          </button>
          <button
            type="button"
            onClick={onSync}
            disabled={source.sync_status === 'syncing'}
            className="text-xs text-blue-600 hover:underline disabled:opacity-50"
          >
            Sync
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="text-red-600 hover:text-red-900"
            title="Delete source"
          >
            <TrashIcon className="size-4 inline" />
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-t bg-neutral-50/40">
          <td colSpan={7} className="px-3 py-3">
            {source.sync_error && (
              <div className="text-xs text-red-600 mb-2">{source.sync_error}</div>
            )}
            {recipes.length === 0 ? (
              <div className="text-xs text-neutral-500">No recipes indexed from this source yet.</div>
            ) : (
              <div className="space-y-1">
                {recipes.map((r) => (
                  <div key={r.id} className="flex items-center justify-between text-xs">
                    <span>
                      <span className="font-medium">{r.title}</span>{' '}
                      <span className="text-neutral-500 font-mono">{r.file_path}</span>
                    </span>
                    <span className="inline-flex items-center gap-2">
                      <StatusBadge status={r.parse_status} />
                      <button
                        type="button"
                        onClick={() => onRunRecipe(r)}
                        disabled={r.parse_status !== 'ok'}
                        className="text-xs text-blue-600 hover:underline disabled:opacity-40"
                      >
                        Run
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function StatusBadge({ status }: { status: 'ok' | 'refused' | 'parse_error' }) {
  if (status === 'ok') return <Badge color="green">ok</Badge>;
  if (status === 'refused') return <Badge color="orange">refused</Badge>;
  return <Badge color="red">parse_error</Badge>;
}

// ─── Add-source modal ───────────────────────────────────────────────

function AddSourceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [label, setLabel] = useState('');
  const [git_url, setGitUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [path_prefix, setPathPrefix] = useState('recipes');
  const [auth_token, setAuthToken] = useState('');
  const [provider, setProvider] = useState<'github' | 'gitlab' | 'gitea'>('github');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!label.trim() || !git_url.trim()) {
      toast.error('Label + git URL required');
      return;
    }
    setSaving(true);
    const r = await RecipesService.createSource({
      label: label.trim(),
      git_url: git_url.trim(),
      branch: branch.trim(),
      path_prefix: path_prefix.trim(),
      ...(auth_token.trim() ? { auth_token: auth_token.trim() } : {}),
      webhook_provider: provider,
    });
    setSaving(false);
    if (!r.ok) {
      toast.error(`Create failed: ${r.error.message}`);
      return;
    }
    toast.success('Source created');
    onCreated();
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Add recipe source"
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Label">
          <input
            className="form-input w-full"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="lf-gatewaze-skills (recipes)"
          />
        </Field>
        <Field label="Git URL">
          <input
            className="form-input w-full font-mono text-xs"
            value={git_url}
            onChange={(e) => setGitUrl(e.target.value)}
            placeholder="https://github.com/<org>/<repo>"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Branch">
            <input
              className="form-input w-full font-mono text-xs"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
            />
          </Field>
          <Field label="Path prefix">
            <input
              className="form-input w-full font-mono text-xs"
              value={path_prefix}
              onChange={(e) => setPathPrefix(e.target.value)}
              placeholder="recipes"
            />
          </Field>
        </div>
        <Field label="Auth token (private repos only)">
          <input
            type="password"
            className="form-input w-full font-mono text-xs"
            value={auth_token}
            onChange={(e) => setAuthToken(e.target.value)}
            placeholder="(leave blank for public repos)"
          />
        </Field>
        <Field label="Webhook provider">
          <select
            className="form-input w-full"
            value={provider}
            onChange={(e) => setProvider(e.target.value as typeof provider)}
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
            <option value="gitea">Gitea</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

// ─── Run-recipe modal ───────────────────────────────────────────────

function RunRecipeModal({
  recipe,
  onClose,
  onRan,
  runResult,
}: {
  recipe: RecipeListItem;
  onClose: () => void;
  onRan: (r: RecipeRun) => void;
  runResult: RecipeRun | null;
}) {
  const [full, setFull] = useState<RecipeFull | null>(null);
  const [useCase, setUseCase] = useState('daily-briefing-research');
  const [params, setParams] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await RecipesService.readRecipe(recipe.id);
      if (cancelled) return;
      if (!r.ok) {
        toast.error(`Failed to load recipe: ${r.error.message}`);
        return;
      }
      setFull(r.value);
      const initial: Record<string, string> = {};
      for (const p of r.value.parameters as Array<{ key?: string; default?: unknown }>) {
        if (typeof p.key === 'string' && p.default !== undefined) {
          initial[p.key] = String(p.default);
        }
      }
      setParams(initial);
    })();
    return () => {
      cancelled = true;
    };
  }, [recipe.id]);

  async function handleRun() {
    if (!full) return;
    setRunning(true);
    const r = await RecipesService.runRecipe(recipe.id, { use_case: useCase, params });
    setRunning(false);
    if (!r.ok) {
      toast.error(`Run failed: ${r.error.message}`);
      return;
    }
    onRan(r.value);
    toast.success(`Run ${r.value.status} in ${Math.round((r.value.duration_ms ?? 0) / 1000)}s`);
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Run ${recipe.title}`}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={running}>Close</Button>
          {!runResult && (
            <Button onClick={handleRun} disabled={running || !full}>
              {running ? 'Running…' : 'Run'}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {!full ? (
          <div className="flex justify-center p-4"><LoadingSpinner /></div>
        ) : !runResult ? (
          <>
            <p className="text-xs text-neutral-500">{full.description}</p>
            <Field label="Use case">
              <input
                className="form-input w-full"
                value={useCase}
                onChange={(e) => setUseCase(e.target.value)}
                placeholder="daily-briefing-research"
              />
            </Field>
            {full.parameters.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium">Parameters</div>
                {(full.parameters as Array<{
                  key?: string;
                  description?: string;
                  requirement?: string;
                  input_type?: string;
                }>).map((p) =>
                  p.key ? (
                    <Field
                      key={p.key}
                      label={`${p.key}${p.requirement === 'required' ? ' *' : ''}`}
                    >
                      <input
                        className="form-input w-full"
                        value={params[p.key] ?? ''}
                        onChange={(e) =>
                          setParams((prev) => ({ ...prev, [p.key!]: e.target.value }))
                        }
                        placeholder={
                          p.description
                            ? `${p.input_type ?? 'string'} — ${p.description}`
                            : p.input_type
                        }
                      />
                    </Field>
                  ) : null,
                )}
              </div>
            )}
          </>
        ) : (
          <RunResultPanel run={runResult} />
        )}
      </div>
    </Modal>
  );
}

function RunResultPanel({ run }: { run: RecipeRun }) {
  return (
    <div className="space-y-4 text-sm">
      <div className="grid grid-cols-3 gap-3 text-xs">
        <div>
          <div className="text-neutral-500">Status</div>
          <div>
            <Badge color={run.status === 'complete' ? 'green' : run.status === 'failed' ? 'red' : 'orange'}>
              {run.status}
            </Badge>
          </div>
        </div>
        <div>
          <div className="text-neutral-500">Cost</div>
          <div className="font-mono">{microUsd(run.total_cost_micro_usd)}</div>
        </div>
        <div>
          <div className="text-neutral-500">Duration</div>
          <div className="font-mono">{run.duration_ms ? `${Math.round(run.duration_ms / 1000)}s` : '—'}</div>
        </div>
      </div>
      {run.failure_reason && (
        <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
          {run.failure_reason}
        </div>
      )}
      {run.recipe_source && <RecipeSourceBadge run={run} />}
      <div>
        <div className="text-sm font-medium mb-1">Steps</div>
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-neutral-50">
              <tr className="text-left">
                <th className="px-3 py-1">#</th>
                <th className="px-3 py-1">Provider / model</th>
                <th className="px-3 py-1">Status</th>
                <th className="px-3 py-1 text-right">Cost</th>
                <th className="px-3 py-1 text-right">Duration</th>
              </tr>
            </thead>
            <tbody>
              {run.steps.map((s) => (
                <tr key={s.step_id} className="border-t">
                  <td className="px-3 py-1 font-mono">{s.step_id}</td>
                  <td className="px-3 py-1">
                    {s.provider && s.model ? (
                      <span className="font-mono text-neutral-700">
                        {s.provider} / {s.model}
                      </span>
                    ) : (
                      <span className="text-neutral-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1">
                    <Badge
                      color={
                        s.status === 'complete'
                          ? 'green'
                          : s.status === 'skipped'
                            ? 'gray'
                            : 'red'
                      }
                    >
                      {s.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-1 text-right font-mono">{microUsd(s.cost_micro_usd)}</td>
                  <td className="px-3 py-1 text-right font-mono">
                    {s.duration_ms ? `${Math.round(s.duration_ms / 1000)}s` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {run.final_output != null && (
        <div>
          <div className="text-sm font-medium mb-1">Final output</div>
          <pre className="rounded-md bg-neutral-50 border px-3 py-2 text-xs overflow-x-auto max-h-72">
{typeof run.final_output === 'string'
  ? run.final_output
  : JSON.stringify(run.final_output, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-neutral-700 mb-1">{label}</span>
      {children}
    </label>
  );
}

/**
 * Provenance badge — surfaces which recipe version + commit was used.
 * Lets operators verify that a recipe update has actually rolled out.
 * Migration 023.
 */
function RecipeSourceBadge({ run }: { run: RecipeRun }): JSX.Element | null {
  const src = run.recipe_source;
  if (!src) return null;
  const shortHash = (s: string | null | undefined): string => {
    if (!s) return '—';
    const h = s.replace(/^sha256:/, '');
    return h.length >= 8 ? h.slice(0, 8) : h;
  };
  const isInline = src.kind === 'inline';
  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs space-y-1">
      <div className="font-medium text-neutral-700">Recipe source</div>
      <ProvenanceRow label="Kind" value={isInline ? 'inline (no source row)' : 'source-registered'} />
      {!isInline && src.source && (
        <>
          <ProvenanceRow label="Source" value={`${src.source.label} (${src.source.branch})`} />
          <ProvenanceRow
            label="Source commit"
            value={shortHash(src.source.last_synced_commit)}
          />
        </>
      )}
      {src.file_path && <ProvenanceRow label="File path" value={src.file_path} />}
      <ProvenanceRow label="Recipe content hash" value={shortHash(src.content_hash)} />
      {src.last_commit_sha && (
        <ProvenanceRow label="Recipe commit" value={shortHash(src.last_commit_sha)} />
      )}
      {src.sub_recipes.length > 0 && (
        <>
          <div className="text-neutral-500 pt-1">Sub-recipes ({src.sub_recipes.length})</div>
          {src.sub_recipes.map((sr) => (
            <div key={sr.file_path} className="ml-3 flex gap-2 items-baseline">
              <span className="font-mono text-neutral-700">{sr.file_path}</span>
              <span className="text-neutral-500">@ {shortHash(sr.last_commit_sha)}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function ProvenanceRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex gap-2 items-baseline">
      <div className="w-40 shrink-0 text-neutral-500">{label}</div>
      <div className="font-mono text-neutral-800 break-all">{value}</div>
    </div>
  );
}
