/**
 * Publishing — newsletter Settings panel.
 *
 * Where rendered editions are pushed when an edition is published to git.
 * This is deliberately separate from the TEMPLATE repo (Template tab): a
 * publication can take its wrapper and blocks from one repo and publish its
 * editions to another.
 *
 * Writes `git_provenance` + `git_url` on the collection (the gate
 * publish-to-git checks) and `config.publish.external_branch` (the remote
 * branch; defaults to `publish`). Credentials: publish-to-git pushes with
 * the access token of the template source whose URL matches the publishing
 * repo, so when the two repos differ the publishing repo also needs to be
 * connected on the Template tab (as a second source) for its token to be
 * on file — the panel says so when that is the case.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';

interface CollectionPublishing {
  git_provenance: string | null;
  git_url: string | null;
  git_branch: string | null;
  config: { publish?: { external_branch?: string } } | null;
}

const FIELD = 'w-full px-3 py-2 text-sm border border-[var(--gray-a6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)] disabled:bg-[var(--gray-a3)] disabled:text-[var(--gray-10)]';
const LABEL = 'block text-xs font-medium text-[var(--gray-11)] mb-1';

export function PublishingSettings({ collectionId }: { collectionId: string }) {
  const [coll, setColl] = useState<CollectionPublishing | null>(null);
  const [sourceUrls, setSourceUrls] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('publish');

  const load = useCallback(async () => {
    const [collRes, srcRes] = await Promise.all([
      supabase.from('newsletters_template_collections').select('git_provenance, git_url, git_branch, config').eq('id', collectionId).maybeSingle<CollectionPublishing>(),
      supabase.from('templates_sources').select('url').eq('library_id', collectionId).eq('kind', 'git').eq('status', 'active'),
    ]);
    const c = collRes.data ?? null;
    setColl(c);
    setUrl(c?.git_url ?? '');
    setBranch(c?.config?.publish?.external_branch ?? c?.git_branch ?? 'publish');
    setSourceUrls(((srcRes.data ?? []) as Array<{ url: string | null }>).map((r) => r.url ?? '').filter(Boolean));
    setLoading(false);
  }, [collectionId]);

  useEffect(() => { void load(); }, [load]);

  const wired = coll?.git_provenance === 'external' && !!coll?.git_url;
  const tokenOnFile = !!coll?.git_url && sourceUrls.includes(coll.git_url);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (trimmed && !/^https:\/\/[^\s]+$|^git@[^\s]+:[^\s]+$/.test(trimmed)) { toast.error('Enter an https:// or git@ repository URL'); return; }
    setSaving(true);
    try {
      const { data: prev } = await supabase.from('newsletters_template_collections').select('config').eq('id', collectionId).maybeSingle<{ config: Record<string, unknown> | null }>();
      const config = { ...((prev?.config ?? {}) as Record<string, unknown>) };
      const publish = { ...((config.publish as Record<string, unknown> | undefined) ?? {}), external_branch: branch.trim() || 'publish' };
      config.publish = publish;
      const { error } = await supabase
        .from('newsletters_template_collections')
        .update(trimmed ? { git_provenance: 'external', git_url: trimmed, config } : { git_provenance: 'internal', git_url: null, config })
        .eq('id', collectionId);
      if (error) throw error;
      toast.success(trimmed ? 'Publishing repo saved' : 'Publishing set to the internal repo');
      setEditing(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save publishing settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent-9)]" /></div>;

  return (
    <div className="border border-[var(--gray-a5)] rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--gray-a5)] bg-[var(--gray-a2)]">
        <h3 className="text-sm font-semibold text-[var(--gray-12)]">Publishing</h3>
        <p className="text-xs text-[var(--gray-11)] mt-0.5">Where published editions are pushed. The template repo is configured on the Template tab and can be a different repo.</p>
      </div>
      <div className="p-4 space-y-4">
        <div className="text-sm">
          {wired ? (
            <>
              <p className="text-[var(--gray-12)]"><code>{coll!.git_url}</code> · branch <code>{branch}</code></p>
              {!tokenOnFile && (
                <p className="text-xs text-[var(--amber-11)] mt-1">No access token on file for this repo. Connect it on the Template tab as well (its token is what the push uses), or publish to the template repo.</p>
              )}
            </>
          ) : (
            <p className="text-[var(--gray-10)]">Internal repo only — published editions stay on the platform.</p>
          )}
        </div>
        {!editing ? (
          <button type="button" onClick={() => setEditing(true)} className="px-3 py-2 text-sm rounded-md border border-[var(--gray-a6)] text-[var(--gray-12)] hover:bg-[var(--gray-a3)]">
            {wired ? 'Change publishing repo' : 'Publish to an external repo'}
          </button>
        ) : (
          <form onSubmit={save} className="space-y-3 border-t border-[var(--gray-a4)] pt-4">
            <div>
              <label className={LABEL}>Repository URL (blank = internal repo)</label>
              <input className={FIELD} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/org/newsletter-site.git" />
            </div>
            <div>
              <label className={LABEL}>Branch</label>
              <input className={FIELD} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="publish" />
            </div>
            <div className="flex items-center gap-2">
              <button type="submit" disabled={saving} className="px-3 py-2 text-sm font-medium rounded-md bg-[var(--accent-9)] text-[var(--accent-contrast,#fff)] disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
              <button type="button" onClick={() => { setEditing(false); void load(); }} className="px-3 py-2 text-sm rounded-md border border-[var(--gray-a6)] text-[var(--gray-11)]">Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default PublishingSettings;
