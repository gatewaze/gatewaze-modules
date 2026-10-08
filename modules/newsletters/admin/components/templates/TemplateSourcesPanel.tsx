/**
 * TemplateSourcesPanel — where a templates library's blocks and wrapper come
 * from, and the git repo that feeds it.
 *
 * Shared by a newsletter publication's Template tab (library = the
 * publication) and the broadcasts Template tab (library = the one shared
 * broadcast library). Everything here is about the TEMPLATE repo only;
 * where a newsletter publishes rendered editions is a separate setting on
 * its Settings tab (PublishingSettings), so a publication can take its
 * template from one repo and publish to another.
 *
 * Super-admin only by convention: both hosts gate the tab that renders it.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { RectangleGroupIcon } from '@heroicons/react/24/outline';
import { Badge, Button } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { dedupeConnectedRepos, type ConnectedRepo, type ConnectedRepoSource } from '../../lib/connectedRepos';

/** Columns we read off `templates_sources` — keep aligned with the SELECT in `reload()`. */
export interface TemplatesSourceRow {
  id: string;
  library_id: string;
  kind: 'git' | 'upload' | 'inline';
  label: string;
  status: 'active' | 'paused' | 'errored';
  url: string | null;
  branch: string | null;
  manifest_path: string | null;
  installed_git_sha: string | null;
  available_git_sha: string | null;
  last_checked_at: string | null;
  last_check_error: string | null;
  created_at: string;
}

export type TemplateHostKind = 'newsletter' | 'broadcasts';

export interface TemplateSourcesPanelProps {
  libraryId: string;
  hostKind: TemplateHostKind;
  /** Route for the one-off HTML upload page, when the host has one. */
  uploadHref?: string;
  /** Route to a block's editor, when the host has one (hand-managed libraries only). */
  blockHref?: (blockType: string) => string;
  /** Called after anything changed (source connected, updated, deleted, seeded). */
  onChanged?: () => void;
}

const apiBase = (): string => import.meta.env.VITE_API_URL ?? '';

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function TemplateSourcesPanel({ libraryId, hostKind, uploadHref, blockHref, onChanged }: TemplateSourcesPanelProps) {
  const navigate = useNavigate();
  const [blocks, setBlocks] = useState<Array<{ id: string; key: string; name: string }>>([]);
  const [sources, setSources] = useState<TemplatesSourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  const reload = useCallback(async () => {
    const [blocksRes, sourcesRes] = await Promise.all([
      // is_current=true: templates_apply_source soft-deletes pruned rows by
      // flipping is_current to false (it keeps a history row for the audit
      // trail); without the filter every repo update that drops a block
      // would leave a phantom here.
      supabase.from('templates_block_defs').select('id, key, name').eq('library_id', libraryId).eq('is_current', true).order('key'),
      supabase
        .from('templates_sources')
        .select('id, library_id, kind, label, status, url, branch, manifest_path, installed_git_sha, available_git_sha, last_checked_at, last_check_error, created_at')
        .eq('library_id', libraryId)
        .order('created_at', { ascending: false }),
    ]);
    setBlocks((blocksRes.data ?? []) as Array<{ id: string; key: string; name: string }>);
    setSources((sourcesRes.data ?? []) as TemplatesSourceRow[]);
    setLoading(false);
  }, [libraryId]);

  const changed = useCallback(() => { void reload(); onChanged?.(); }, [reload, onChanged]);

  // An active git source owns the block rows (templates_apply_source), so
  // the library is read-only here: no per-block editing, no one-off upload
  // (it would race the next apply), no boilerplate seed.
  const gitManaged = sources.some((s) => s.kind === 'git' && s.status === 'active');

  useEffect(() => { void reload(); }, [reload]);

  // Realtime: the drift-monitor worker updates templates_sources rows
  // (last_checked_at, available_git_sha, …); refresh when ours change.
  useEffect(() => {
    const channel = supabase
      .channel(`templates_sources:library=${libraryId}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        { event: '*', schema: 'public', table: 'templates_sources', filter: `library_id=eq.${libraryId}` },
        () => { void reload(); },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [libraryId, reload]);

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent-9)]" /></div>;

  const noun = hostKind === 'broadcasts' ? 'broadcasts' : 'this newsletter';

  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold text-[var(--gray-12)]">Template repository</h2>
            <p className="text-xs text-[var(--gray-9)] mt-0.5">
              The git repo that holds the wrapper and blocks for {noun}. Connect a new one, or reuse a repo already connected elsewhere.
            </p>
          </div>
          <div className="flex gap-2">
            {!gitManaged && uploadHref && (
              <Button variant="outline" onClick={() => navigate(uploadHref)}>Upload HTML</Button>
            )}
            {!gitManaged && !connecting && (
              <Button variant="solid" onClick={() => setConnecting(true)}>Connect a repo</Button>
            )}
          </div>
        </div>

        {connecting && (
          <ConfigureGitSourceForm
            libraryId={libraryId}
            onSaved={() => { setConnecting(false); changed(); }}
            onCancel={() => setConnecting(false)}
          />
        )}

        {sources.length === 0 ? (
          !connecting && <div className="text-sm text-[var(--gray-9)] italic mt-3">No repo connected — {noun === 'broadcasts' ? 'broadcasts use' : 'editions use'} the built-in blocks and wrapper.</div>
        ) : (
          <ul className="space-y-2 mt-3">
            {sources.map((s) => (
              <SourceRow key={s.id} source={s} hostKind={hostKind} onChanged={changed} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-3 flex items-center gap-2">
          Block templates
          {gitManaged && <Badge color="gray">Managed by git</Badge>}
        </h2>
        {blocks.length === 0 ? (
          <div className="text-center py-12 text-[var(--gray-9)]">
            <RectangleGroupIcon className="h-12 w-12 mx-auto mb-3 text-[var(--gray-8)]" />
            <p className="mb-2">No block templates yet</p>
            {gitManaged ? (
              <p className="text-sm mb-4">Push a block file to the connected repo, then run Update on the source above.</p>
            ) : (
              <>
                <p className="text-sm mb-4">Connect a repo above{uploadHref ? ', upload an HTML template,' : ''} or start from the Gatewaze boilerplate.</p>
                <SeedFromBoilerplateButton libraryId={libraryId} hostKind={hostKind} onSeeded={changed} />
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {blocks.map((block) => {
              const href = !gitManaged && blockHref ? blockHref(block.key) : null;
              return (
                <div
                  key={block.id}
                  className={href ? 'p-4 border border-[var(--gray-a5)] rounded-lg hover:bg-[var(--gray-a2)] cursor-pointer transition-colors' : 'p-4 border border-[var(--gray-a5)] rounded-lg'}
                  onClick={href ? () => navigate(href) : undefined}
                >
                  <p className="text-sm font-medium text-[var(--gray-12)]">{block.name}</p>
                  <p className="text-xs text-[var(--gray-9)] mt-0.5">{block.key}</p>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * One configured source: status, drift indicator (the cron noticed
 * upstream changes), and per-source actions.
 */
function SourceRow({ source: s, hostKind, onChanged }: { source: TemplatesSourceRow; hostKind: TemplateHostKind; onChanged: () => void }) {
  const [busy, setBusy] = useState<'apply' | 'delete' | null>(null);
  const [editing, setEditing] = useState(false);
  const isDrifted = s.kind === 'git' && !!s.available_git_sha && s.available_git_sha !== s.installed_git_sha;

  const handleDelete = async () => {
    if (!confirm(`Delete source "${s.label}"? Blocks already imported from it stay in the library.`)) return;
    setBusy('delete');
    try {
      const res = await fetch(`${apiBase()}/api/modules/templates/sources/${s.id}`, { method: 'DELETE', headers: await authHeader() });
      const body = await res.json().catch(() => null);
      if (!res.ok) { toast.error(body?.error?.message ?? `Delete failed (${res.status})`); return; }
      toast.success('Source deleted');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  };

  // Re-apply the repo at HEAD: block/brick/wrapper defs in one pass through
  // the templates module's apply. Newsletters additionally pull their
  // declarative (html-ish) blocks through the collection sync endpoint.
  const handleUpdate = async () => {
    setBusy('apply');
    try {
      const headers = { 'Content-Type': 'application/json', ...(await authHeader()) };
      const applyRes = await fetch(`${apiBase()}/api/modules/templates/sources/${s.id}/apply`, { method: 'POST', headers });
      const applyBody = await applyRes.json().catch(() => null);
      if (!applyRes.ok) {
        // A fully-declarative repo has no template.html blocks to apply; do
        // not let that short-circuit the declarative sync below.
        // eslint-disable-next-line no-console
        console.warn('[template-source] apply skipped/failed (continuing)', applyBody);
      }
      let declCount = 0;
      if (hostKind === 'newsletter') {
        const declRes = await fetch(`${apiBase()}/api/admin/newsletters/collections/${s.library_id}/sync-declarative-blocks`, { method: 'POST', headers });
        const declBody = (await declRes.json().catch(() => null)) as { synced?: number; bricksSynced?: number } | null;
        if (declRes.ok) declCount = (declBody?.synced ?? 0) + (declBody?.bricksSynced ?? 0);
      }
      const applyCount = Array.isArray(applyBody?.applied) ? applyBody.applied.length : 0;
      const total = applyCount + declCount;
      toast.success(`Template updated — ${total} item${total === 1 ? '' : 's'} synced`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="p-3 border border-[var(--gray-a5)] rounded-lg flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-[var(--gray-12)]">{s.label}</span>
          <Badge variant="soft" color={s.status === 'active' ? 'green' : s.status === 'errored' ? 'red' : 'gray'}>{s.status}</Badge>
          <Badge variant="soft">{s.kind}</Badge>
          {isDrifted && <Badge variant="soft" color="amber">Update available</Badge>}
        </div>
        {s.kind === 'git' && s.url && (
          <p className="text-xs text-[var(--gray-9)] mt-1 truncate">{s.url}{s.branch ? ` · branch ${s.branch}` : ''}{s.manifest_path ? ` · path ${s.manifest_path}` : ''}</p>
        )}
        {s.installed_git_sha && (
          <p className="text-xs text-[var(--gray-a11)] mt-0.5">
            Installed: <code>{s.installed_git_sha.slice(0, 8)}</code>
            {isDrifted && <> → available: <code className="text-[var(--amber-11)]">{s.available_git_sha!.slice(0, 8)}</code></>}
          </p>
        )}
        {s.last_checked_at && <p className="text-xs text-[var(--gray-a11)] mt-0.5">Last checked: {new Date(s.last_checked_at).toLocaleString()}</p>}
        {s.last_check_error && <p className="text-xs text-[var(--red-11)] mt-0.5">{s.last_check_error}</p>}
      </div>
      {s.kind === 'git' && (
        <div className="flex flex-col gap-1.5 shrink-0">
          <Button variant={isDrifted ? 'solid' : 'outline'} size="1" onClick={handleUpdate} disabled={busy !== null} title="Pull the latest template from git">
            {busy === 'apply' ? 'Updating…' : isDrifted ? 'Update available' : 'Update'}
          </Button>
          <Button variant="outline" size="1" onClick={() => setEditing((v) => !v)} disabled={busy !== null}>{editing ? 'Cancel' : 'Edit'}</Button>
          <Button variant="outline" color="red" size="1" onClick={handleDelete} disabled={busy !== null}>{busy === 'delete' ? 'Deleting…' : 'Delete'}</Button>
        </div>
      )}
      {editing && s.kind === 'git' && (
        <div className="w-full mt-2 basis-full">
          <ConfigureGitSourceForm libraryId={s.library_id} existing={s} onSaved={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />
        </div>
      )}
    </li>
  );
}

/** One-click seed from the Gatewaze boilerplate (server dereferences the configured boilerplate URL). */
function SeedFromBoilerplateButton({ libraryId, hostKind, onSeeded }: { libraryId: string; hostKind: TemplateHostKind; onSeeded: () => void }) {
  const [busy, setBusy] = useState(false);
  const handleClick = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${apiBase()}/api/modules/templates/libraries/${libraryId}/seed-from-boilerplate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ host_kind: hostKind }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { toast.error(body?.error?.message ?? `Boilerplate seed failed (${res.status})`); return; }
      toast.success(`Imported ${body?.apply?.artifacts?.length ?? 0} template(s) from boilerplate`);
      onSeeded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Boilerplate seed failed');
    } finally {
      setBusy(false);
    }
  };
  return <Button variant="solid" onClick={handleClick} disabled={busy}>{busy ? 'Importing…' : 'Start from boilerplate'}</Button>;
}

const FIELD = 'w-full px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded bg-[var(--color-background)] disabled:bg-[var(--gray-a3)] disabled:text-[var(--gray-10)] disabled:cursor-not-allowed';
const LABEL = 'block text-xs font-medium text-[var(--gray-11)] mb-1';

/**
 * Connect (POST) or edit (PATCH) a git source. On connect, a repo already
 * connected elsewhere can be picked instead of typed: the API clones that
 * source — URL, branch, path and the stored token — into this library.
 */
function ConfigureGitSourceForm({ libraryId, existing, onSaved, onCancel }: { libraryId: string; existing?: TemplatesSourceRow; onSaved: () => void; onCancel?: () => void }) {
  const isEdit = !!existing;
  const [url, setUrl] = useState(existing?.url ?? '');
  const [branch, setBranch] = useState(existing?.branch ?? '');
  const [manifestPath, setManifestPath] = useState(existing?.manifest_path ?? '');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState(existing?.label ?? 'Template repo');
  const [submitting, setSubmitting] = useState(false);
  const [connected, setConnected] = useState<ConnectedRepo[]>([]);
  const [reuseId, setReuseId] = useState<string>('');

  // Repos connected to any other library the caller can see. Tokens never
  // come down — the clone endpoint copies them server-side.
  useEffect(() => {
    if (isEdit) return;
    let cancelled = false;
    void supabase
      .from('templates_sources')
      .select('id, library_id, kind, status, label, url, branch, manifest_path, created_at, library:templates_libraries(name, host_kind)')
      .eq('kind', 'git')
      .eq('status', 'active')
      .then(({ data }) => {
        if (cancelled) return;
        setConnected(dedupeConnectedRepos((data ?? []) as unknown as ConnectedRepoSource[], libraryId));
      });
    return () => { cancelled = true; };
  }, [isEdit, libraryId]);

  const reuse = connected.find((c) => c.sourceId === reuseId) ?? null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!reuse && !url.trim()) { toast.error('Repository URL is required'); return; }
    setSubmitting(true);
    try {
      const headers = { 'Content-Type': 'application/json', ...(await authHeader()) };
      let res: Response;
      if (reuse) {
        res = await fetch(`${apiBase()}/api/modules/templates/sources/${reuse.sourceId}/clone`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ library_id: libraryId, label: label.trim() || reuse.label }),
        });
      } else if (isEdit) {
        res = await fetch(`${apiBase()}/api/modules/templates/sources/${existing!.id}`, {
          method: 'PATCH',
          headers,
          // Token only when a new one was typed; blank keeps the stored one.
          body: JSON.stringify({ label: label.trim() || 'Template repo', branch: branch.trim() || null, manifest_path: manifestPath.trim() || null, ...(token.trim() ? { token: token.trim() } : {}) }),
        });
      } else {
        res = await fetch(`${apiBase()}/api/modules/templates/sources`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ library_id: libraryId, kind: 'git', label: label.trim() || 'Template repo', url: url.trim(), branch: branch.trim() || undefined, manifest_path: manifestPath.trim() || undefined, token: token.trim() || undefined }),
        });
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) { toast.error(body?.error?.message ?? `Request failed (${res.status})`); return; }
      toast.success(isEdit ? 'Source updated' : `Connected — ${body?.apply?.artifacts?.length ?? 0} template(s) imported`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save git source');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="p-4 border border-[var(--gray-a5)] rounded-lg space-y-3 mb-3 bg-[var(--gray-a2)]">
      {!isEdit && connected.length > 0 && (
        <div>
          <label className={LABEL}>Reuse a connected repo</label>
          <select className={FIELD} value={reuseId} onChange={(e) => setReuseId(e.target.value)}>
            <option value="">Connect a new repo…</option>
            {connected.map((c) => (
              <option key={c.sourceId} value={c.sourceId}>
                {c.url}{c.branch ? ` · ${c.branch}` : ''}{c.manifestPath ? ` · ${c.manifestPath}` : ''} — used by {c.connectedTo.join(', ')}
              </option>
            ))}
          </select>
          {reuse && <p className="text-xs text-[var(--gray-10)] mt-1">Its URL, branch, path and access token are copied over; nothing to type.</p>}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>Label</label>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} className={FIELD} placeholder="Template repo" />
        </div>
        <div>
          <label className={LABEL}>Repository URL {!reuse && <span className="text-[var(--red-11)]">*</span>}</label>
          <input type="text" value={reuse ? reuse.url : url} onChange={(e) => setUrl(e.target.value)} disabled={isEdit || !!reuse} className={FIELD} placeholder="https://github.com/owner/repo.git" required={!reuse} title={isEdit ? 'Repository URL is fixed; delete and reconnect to change it' : ''} />
        </div>
        <div>
          <label className={LABEL}>Branch</label>
          <input type="text" value={reuse ? (reuse.branch ?? '') : branch} onChange={(e) => setBranch(e.target.value)} disabled={!!reuse} className={FIELD} placeholder="main" />
        </div>
        <div>
          <label className={LABEL}>Templates path (optional)</label>
          <input type="text" value={reuse ? (reuse.manifestPath ?? '') : manifestPath} onChange={(e) => setManifestPath(e.target.value)} disabled={!!reuse} className={FIELD} placeholder="templates/email" />
        </div>
        {!reuse && (
          <div className="md:col-span-2">
            <label className={LABEL}>Personal access token {isEdit ? '(leave blank to keep the current token)' : '(private repos only)'}</label>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} className={FIELD} placeholder={isEdit ? 'ghp_… (only fill in to rotate the token)' : 'ghp_… (leave blank for public repos)'} autoComplete="off" />
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="solid" disabled={submitting}>{submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Connect'}</Button>
        {onCancel && <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>Cancel</Button>}
      </div>
    </form>
  );
}

export default TemplateSourcesPanel;
