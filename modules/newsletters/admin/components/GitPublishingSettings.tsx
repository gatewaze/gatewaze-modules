/**
 * Git & Publishing — newsletter Settings panel.
 *
 * One place to point a newsletter at a git repo that serves BOTH jobs:
 *   - `main`    → the template (parsed into the block library via the
 *                 templates git source — read)
 *   - `publish` → rendered editions (publish-to-git pushes here — write)
 *
 * Connecting writes two things, reusing the proven flow from the old
 * Template-tab source form:
 *   1. a templates git source row (kind='git', library_id = collection id,
 *      url/branch/manifest_path + the PAT in token_secret_ref) — drives the
 *      template sync, and
 *   2. the collection's `git_provenance='external' + git_url` — the gate that
 *      lets publish-to-git push editions to the same repo (it reuses the
 *      source PAT for the push).
 *
 * A single read+write PAT covers both. The publish branch keeps its
 * migration-027 default (`publish`) and is shown for reference, not edited.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';

interface GitSourceRow {
  id: string;
  url: string | null;
  branch: string | null;
  manifest_path: string | null;
  installed_git_sha: string | null;
  last_checked_at: string | null;
  last_check_error: string | null;
}

interface CollectionGit {
  git_provenance: string | null;
  git_url: string | null;
  git_branch: string | null;
}

const FIELD =
  'w-full px-3 py-2 text-sm rounded-md border border-[var(--gray-a6)] bg-[var(--color-surface,#fff)] text-[var(--gray-12)] outline-none focus:border-[var(--accent-8)]';
const LABEL = 'block text-xs font-medium text-[var(--gray-11)] mb-1';

export function GitPublishingSettings({ collectionId }: { collectionId: string }) {
  const [source, setSource] = useState<GitSourceRow | null>(null);
  const [coll, setColl] = useState<CollectionGit | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [templateBranch, setTemplateBranch] = useState('main');
  const [templatesPath, setTemplatesPath] = useState('');

  const load = useCallback(async () => {
    const [srcRes, collRes] = await Promise.all([
      supabase
        .from('templates_sources')
        .select('id, url, branch, manifest_path, installed_git_sha, last_checked_at, last_check_error')
        .eq('library_id', collectionId)
        .eq('kind', 'git')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('newsletters_template_collections')
        .select('git_provenance, git_url, git_branch')
        .eq('id', collectionId)
        .maybeSingle(),
    ]);
    const s = (srcRes.data as GitSourceRow | null) ?? null;
    const c = (collRes.data as CollectionGit | null) ?? null;
    setSource(s);
    setColl(c);
    setUrl(s?.url ?? c?.git_url ?? '');
    setTemplateBranch(s?.branch ?? 'main');
    setTemplatesPath(s?.manifest_path ?? '');
    setEditing(!s); // no source yet → start in the connect form
    setLoading(false);
  }, [collectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) {
      toast.error('Repository URL is required');
      return;
    }
    if (!source && !token.trim()) {
      toast.error('A personal access token is required to connect a private repo');
      return;
    }
    setSaving(true);
    try {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      const isEdit = !!source;
      const endpoint = isEdit
        ? `/api/modules/templates/sources/${source!.id}`
        : '/api/modules/templates/sources';
      const body = isEdit
        ? {
            branch: templateBranch.trim() || null,
            manifest_path: templatesPath.trim() || null,
            // Only send the token if the operator typed a new one — blank
            // keeps the stored PAT (don't clear it on an edit).
            ...(token.trim() ? { token: token.trim() } : {}),
          }
        : {
            library_id: collectionId,
            kind: 'git',
            label: 'Newsletter repo',
            url: url.trim(),
            branch: templateBranch.trim() || undefined,
            manifest_path: templatesPath.trim() || undefined,
            token: token.trim() || undefined,
          };
      const res = await fetch(endpoint, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: accessToken ? `Bearer ${accessToken}` : '',
        },
        body: JSON.stringify(body),
      });
      const respBody = (await res.json().catch(() => null)) as
        | { error?: { message?: string }; apply?: { artifacts?: unknown[] } }
        | null;
      if (!res.ok) {
        toast.error(respBody?.error?.message ?? `Request failed (${res.status})`);
        return;
      }

      // Publishing side: flip the collection to external git so publish-to-git
      // pushes rendered editions to the same repo's publish branch (it reuses
      // the source PAT). Non-fatal if it fails — the template sync still works.
      const { error: collErr } = await supabase
        .from('newsletters_template_collections')
        .update({ git_provenance: 'external', git_url: url.trim() })
        .eq('id', collectionId);
      if (collErr) {
        // eslint-disable-next-line no-console
        console.warn('[git-publishing] could not set collection git_url/provenance:', collErr);
      }

      toast.success(
        isEdit
          ? 'Git & publishing updated'
          : `Connected — ${respBody?.apply?.artifacts?.length ?? 0} template(s) imported`,
      );
      setToken('');
      setEditing(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save git settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent-9)]" />
      </div>
    );
  }

  const connected = !!source;
  const publishWired = coll?.git_provenance === 'external' && !!coll?.git_url;
  const publishBranch = coll?.git_branch ?? 'publish';

  return (
    <div className="border border-[var(--gray-a5)] rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--gray-a5)] bg-[var(--gray-a2)]">
        <h3 className="text-sm font-semibold text-[var(--gray-12)]">Git &amp; Publishing</h3>
        <p className="text-xs text-[var(--gray-11)] mt-0.5">
          Connect one repo that holds the template on <code>{templateBranch || 'main'}</code> and
          receives published editions on <code>{publishBranch}</code>. A single read &amp; write
          personal access token covers both.
        </p>
      </div>

      <div className="p-4 space-y-4">
        {/* Status summary */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <StatusItem
            label="Template source"
            ok={connected}
            lines={
              connected
                ? [
                    `${source!.url}`,
                    `branch ${source!.branch ?? 'main'}${source!.manifest_path ? ` · ${source!.manifest_path}` : ''}`,
                    source!.installed_git_sha ? `synced @ ${source!.installed_git_sha.slice(0, 7)}` : 'not yet synced',
                    ...(source!.last_check_error ? [`error: ${source!.last_check_error.split('\n')[0]}`] : []),
                  ]
                : ['Not connected — the editor uses the built-in block library.']
            }
          />
          <StatusItem
            label="Publishing"
            ok={publishWired}
            lines={
              publishWired
                ? [`${coll!.git_url}`, `editions push to branch ${publishBranch}`]
                : ['Not wired — published editions stay in the internal repo only.']
            }
          />
        </div>

        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="px-3 py-2 text-sm rounded-md border border-[var(--gray-a6)] bg-[var(--color-surface,#fff)] text-[var(--gray-12)] hover:bg-[var(--gray-a3)]"
          >
            {connected ? 'Edit connection' : 'Connect a repo'}
          </button>
        ) : (
          <form onSubmit={handleSave} className="space-y-3 border-t border-[var(--gray-a4)] pt-4">
            <div>
              <label className={LABEL}>Repository URL *</label>
              <input
                className={FIELD}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/org/newsletter-repo.git"
                disabled={connected /* URL is fixed once connected; reconnect to change */}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={LABEL}>Template branch</label>
                <input className={FIELD} value={templateBranch} onChange={(e) => setTemplateBranch(e.target.value)} placeholder="main" />
              </div>
              <div>
                <label className={LABEL}>Publish branch</label>
                <input className={FIELD} value={publishBranch} disabled title="Editions are written here (fixed)" />
              </div>
            </div>
            <div>
              <label className={LABEL}>Templates path (optional)</label>
              <input className={FIELD} value={templatesPath} onChange={(e) => setTemplatesPath(e.target.value)} placeholder="template.html" />
            </div>
            <div>
              <label className={LABEL}>
                Personal access token (read &amp; write){connected ? ' — leave blank to keep the current token' : ''}
              </label>
              <input
                className={FIELD}
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={connected ? '•••••••• (only fill in to rotate)' : 'ghp_…'}
                autoComplete="off"
              />
              <p className="text-xs text-[var(--gray-10)] mt-1">
                Needs <strong>Contents: Read and write</strong> scoped to this repo — read syncs the
                template, write pushes editions.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={saving}
                className="px-3 py-2 text-sm font-medium rounded-md bg-[var(--accent-9)] text-[var(--accent-contrast,#fff)] disabled:opacity-60"
              >
                {saving ? 'Saving…' : connected ? 'Save changes' : 'Connect'}
              </button>
              {connected && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setToken('');
                  }}
                  className="px-3 py-2 text-sm rounded-md border border-[var(--gray-a6)] text-[var(--gray-11)]"
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function StatusItem({ label, ok, lines }: { label: string; ok: boolean; lines: string[] }) {
  return (
    <div className="rounded-md border border-[var(--gray-a4)] p-3 bg-[var(--gray-a2)]">
      <div className="flex items-center gap-2 mb-1">
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ background: ok ? 'var(--green-9, #30a46c)' : 'var(--gray-7, #b9bbc6)' }}
        />
        <span className="text-xs font-semibold text-[var(--gray-12)]">{label}</span>
      </div>
      {lines.map((l, i) => (
        <div key={i} className="text-xs text-[var(--gray-11)] break-words leading-relaxed">
          {l}
        </div>
      ))}
    </div>
  );
}
