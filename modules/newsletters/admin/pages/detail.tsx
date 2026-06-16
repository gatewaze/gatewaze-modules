import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  Cog6ToothIcon,
  RectangleGroupIcon,
  DocumentTextIcon,
  ChartBarIcon,
  ChatBubbleLeftRightIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Page } from '@/components/shared/Page';
import { Badge, Button, WorkspaceLayout } from '@/components/ui';
import type { Tab } from '@/components/ui/Tabs';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { supabase } from '@/lib/supabase';
import { useHasModule } from '@/hooks/useModuleFeature';
import { NewsletterDetailsForm } from '../components/NewsletterDetailsForm';
import { DeleteNewsletterCard } from '../components/DeleteNewsletterCard';
import { GitPublishingSettings } from '../components/GitPublishingSettings';
import { ViewOnlineSettings } from '../components/ViewOnlineSettings';
import { NewsletterStatsTab } from '../components/NewsletterStatsTab';
import { NewsletterRepliesTab } from '../components/NewsletterRepliesTab';
import { EditorTab } from './EditorTab';

interface Newsletter {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  content_category: string | null;
  accent_color: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  list_id: string | null;
  setup_complete: boolean;
  metadata: Record<string, unknown>;
  subscriber_count?: number;
  edition_count?: number;
}

type NewsletterTab = 'details' | 'template' | 'editions' | 'replies' | 'stats';

export default function NewsletterDetailPage() {
  const { slug, tab: tabFromUrl } = useParams<{ slug: string; tab?: string }>();
  const navigate = useNavigate();
  const hasBulkEmailing = useHasModule('bulk-emailing');

  const [newsletter, setNewsletter] = useState<Newsletter | null>(null);
  const [loading, setLoading] = useState(true);

  const validTabs: NewsletterTab[] = ['details', 'template', 'editions', ...(hasBulkEmailing ? ['replies' as NewsletterTab, 'stats' as NewsletterTab] : [])];
  const defaultTab: NewsletterTab = 'editions';
  const activeTab: NewsletterTab = validTabs.includes(tabFromUrl as NewsletterTab) ? (tabFromUrl as NewsletterTab) : defaultTab;

  const handleTabChange = (tab: string) => {
    navigate(`/newsletters/${slug}/${tab}`, { replace: true });
  };

  const loadNewsletter = useCallback(async () => {
    if (!slug) return;
    try {
      const { data, error } = await supabase
        .from('newsletters_template_collections')
        .select('*')
        .eq('slug', slug)
        .single();

      if (error) throw error;

      const nl: Newsletter = { ...data };

      // Get subscriber count
      if (data.list_id) {
        try {
          const { count } = await supabase
            .from('list_subscriptions')
            .select('id', { count: 'exact', head: true })
            .eq('list_id', data.list_id)
            .eq('subscribed', true);
          nl.subscriber_count = count || 0;
        } catch {}
      }

      // Get edition count
      const { count: edCount } = await supabase
        .from('newsletters_editions')
        .select('id', { count: 'exact', head: true })
        .eq('collection_id', data.id);
      nl.edition_count = edCount || 0;

      setNewsletter(nl);
    } catch (err) {
      console.error('Error loading newsletter:', err);
      toast.error('Newsletter not found');
      navigate('/newsletters');
    } finally {
      setLoading(false);
    }
  }, [slug, navigate]);

  useEffect(() => { loadNewsletter(); }, [loadNewsletter]);

  if (loading) {
    return <Page title="Loading..."><div className="flex items-center justify-center h-64"><LoadingSpinner /></div></Page>;
  }

  if (!newsletter) {
    return <Page title="Not Found"><div className="p-6 text-center text-[var(--gray-9)]">Newsletter not found</div></Page>;
  }

  const ic = 'size-4';

  const tabs: Tab[] = [
    { id: 'details', label: 'Settings', icon: <Cog6ToothIcon className={ic} /> },
    { id: 'template', label: 'Template', icon: <RectangleGroupIcon className={ic} /> },
    { id: 'editions', label: 'Editions', icon: <DocumentTextIcon className={ic} /> },
    ...(hasBulkEmailing ? [
      { id: 'replies', label: 'Replies', icon: <ChatBubbleLeftRightIcon className={ic} /> },
      { id: 'stats', label: 'Stats', icon: <ChartBarIcon className={ic} /> },
    ] : []),
  ];

  return (
    <Page title={newsletter.name}>
      <WorkspaceLayout
        title={`Newsletters: ${newsletter.name}`}
        tabs={tabs}
        activeTabId={activeTab}
        onTabChange={handleTabChange}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {newsletter.content_category && (
              <Badge variant="soft" color="blue" size="1">{newsletter.content_category}</Badge>
            )}
            <span className="text-sm text-[var(--gray-11)]">
              {newsletter.edition_count || 0} edition{newsletter.edition_count !== 1 ? 's' : ''}
            </span>
            {newsletter.subscriber_count != null && (
              <span className="text-sm text-[var(--gray-11)]">
                {newsletter.subscriber_count} subscriber{newsletter.subscriber_count !== 1 ? 's' : ''}
              </span>
            )}
            {!newsletter.setup_complete && (
              <Badge variant="soft" color="orange" size="1">Setup incomplete</Badge>
            )}
          </div>
        }
      >
      {/* Tab Content */}
      {activeTab === 'details' && (
        <div className="py-2 grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <div className="space-y-6">
            <NewsletterDetailsForm newsletter={newsletter} onSave={loadNewsletter} />
            <DeleteNewsletterCard newsletterId={newsletter.id} newsletterName={newsletter.name} />
          </div>
          <div className="space-y-6">
            <GitPublishingSettings collectionId={newsletter.id} />
            <ViewOnlineSettings collectionId={newsletter.id} />
          </div>
        </div>
      )}

      {activeTab === 'template' && (
        <div className="py-2">
          <TemplateTabContent newsletterId={newsletter.id} newsletterSlug={newsletter.slug} />
        </div>
      )}

      {activeTab === 'editions' && (
        <div className="py-2">
          <EditorTab newsletterId={newsletter.id} newsletterSlug={newsletter.slug} setupComplete={newsletter.setup_complete} />
        </div>
      )}

      {activeTab === 'replies' && hasBulkEmailing && (
        <div className="py-2">
          <NewsletterRepliesTab newsletterId={newsletter.id} />
        </div>
      )}

      {activeTab === 'stats' && hasBulkEmailing && (
        <div className="py-2">
          <NewsletterStatsTab newsletterId={newsletter.id} />
        </div>
      )}
      </WorkspaceLayout>
    </Page>
  );
}

/** Narrow shape for the templates_sources rows we read in this tab. Mirrors
 *  the SELECT in `reload()` below — keep in sync if columns change. */
interface TemplatesSourceRow {
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

// Template tab content. Per spec-content-modules-git-architecture §6, every
// newsletter is backed by a real git repo (internal or external). The Source
// section lets the admin configure an external git source; the Block
// Templates list shows what's currently parsed in (irrespective of the
// source kind that produced them — git, upload, or inline).
function TemplateTabContent({ newsletterId, newsletterSlug }: { newsletterId: string; newsletterSlug: string }) {
  const navigate = useNavigate();
  const [blocks, setBlocks] = useState<any[]>([]);
  const [sources, setSources] = useState<TemplatesSourceRow[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const [blocksRes, sourcesRes] = await Promise.all([
      // templates_block_defs uses `key`; alias it back so the click navigation
      // can keep referencing block.block_type.
      //
      // is_current=true is required: templates_apply_source soft-deletes
      // pruned rows by flipping is_current to false (it keeps a history row
      // for the audit trail). Without this filter every template-repo update
      // that drops a block would leave a stale row showing as a phantom on
      // this tab.
      supabase.from('templates_block_defs')
        .select('id, key, name, block_type:key')
        .eq('library_id', newsletterId)
        .eq('is_current', true)
        .order('key'),
      supabase.from('templates_sources')
        // The interface (TemplatesSourceRow) tracks the real columns
        // — `installed_git_sha` + `available_git_sha` + `last_checked_at`
        // — which were emitted by migration 002 of the templates module.
        // An earlier draft of this query asked for `last_applied_sha`,
        // which doesn't exist on the table; PostgREST returned 400 and
        // the whole Template tab failed to render. Keep this list aligned
        // with the interface above.
        .select('id, library_id, kind, label, status, url, branch, manifest_path, installed_git_sha, available_git_sha, last_checked_at, last_check_error, created_at')
        .eq('library_id', newsletterId)
        .order('created_at', { ascending: false }),
    ]);
    setBlocks(blocksRes.data || []);
    setSources(sourcesRes.data || []);
    setLoading(false);
  }, [newsletterId]);

  // True when this newsletter has an active git templates_source. The
  // templates_apply_source RPC owns the block rows in that case, so the
  // tab must treat them as read-only: no per-row edit navigation, no
  // one-off HTML upload (would race with the next apply), no boilerplate
  // seed (the git source is already the source of truth).
  const gitManaged = sources.some((s) => s.kind === 'git' && s.status === 'active');

  useEffect(() => { reload(); }, [reload]);

  // Realtime: when the drift-monitor worker updates a templates_sources
  // row (last_checked_at, available_git_sha, installed_git_sha, status,
  // last_check_error), refresh both lists. Filtered server-side to this
  // newsletter's library so we don't get a re-render every time another
  // brand's source ticks.
  useEffect(() => {
    const channel = supabase
      .channel(`templates_sources:library=${newsletterId}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        // Supabase's .on() overloads narrow `event` to a small union per
        // the channel kind, but the SDK doesn't expose the discriminator
        // reliably for `postgres_changes` from realtime-js v2. Cast at the
        // call site keeps everything else strongly typed.
        'postgres_changes' as any,
        { event: '*', schema: 'public', table: 'templates_sources', filter: `library_id=eq.${newsletterId}` },
        () => { reload(); },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [newsletterId, reload]);

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent-9)]" /></div>;

  return (
    <div className="space-y-8">
      {/* Source section — provenance of this newsletter's templates. The
          git repo is configured on the Settings tab (Git & Publishing);
          this view shows the connected source read-only, plus a one-off
          HTML upload path. */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold text-[var(--gray-12)]">Source</h2>
            <p className="text-xs text-[var(--gray-9)] mt-0.5">
              Where this newsletter&apos;s templates come from. Connect a git repo on the <strong>Settings</strong> tab, or upload a one-off HTML file here.
            </p>
          </div>
          <div className="flex gap-2">
            {!gitManaged && (
              <Button variant="outline" onClick={() => navigate(`/newsletters/templates/${newsletterSlug}/upload`)}>
                Upload HTML
              </Button>
            )}
          </div>
        </div>

        {sources.length === 0 ? (
          <div className="text-sm text-[var(--gray-9)] italic mt-3">No sources configured yet.</div>
        ) : (
          <ul className="space-y-2 mt-3">
            {sources.map((s) => (
              <SourceRow key={s.id} source={s} onChanged={reload} />
            ))}
          </ul>
        )}
      </section>

      {/* Block Templates list (existing) */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-3 flex items-center gap-2">
          Block Templates
          {gitManaged && <Badge color="gray">Managed by git</Badge>}
        </h2>
        {blocks.length === 0 ? (
          <div className="text-center py-12 text-[var(--gray-9)]">
            <RectangleGroupIcon className="h-12 w-12 mx-auto mb-3 text-[var(--gray-8)]" />
            <p className="mb-2">No templates yet</p>
            {gitManaged ? (
              <p className="text-sm mb-4">Push a block file to the connected git repo, then run Update on the source above.</p>
            ) : (
              <>
                <p className="text-sm mb-4">Connect a git repo above, upload an HTML template, or start from the Gatewaze boilerplate.</p>
                <SeedFromBoilerplateButton libraryId={newsletterId} onSeeded={reload} />
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {blocks.map(block => (
              <div
                key={block.id}
                className={
                  gitManaged
                    ? 'p-4 border border-[var(--gray-a5)] rounded-lg'
                    : 'p-4 border border-[var(--gray-a5)] rounded-lg hover:bg-[var(--gray-a2)] cursor-pointer transition-colors'
                }
                onClick={
                  gitManaged
                    ? undefined
                    : () => navigate(`/newsletters/templates/${newsletterSlug}/blocks/${block.block_type}`)
                }
              >
                <p className="text-sm font-medium text-[var(--gray-12)]">{block.name}</p>
                <p className="text-xs text-[var(--gray-9)] mt-0.5">{block.block_type}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Single-row card for a configured templates source. Shows status, drift
 * indicator (when cron noticed upstream changes), and per-source actions:
 * "Check now" forces an immediate poll, "Apply" pulls drifted changes
 * through to templates_block_defs.
 */
function SourceRow({ source: s, onChanged }: { source: TemplatesSourceRow; onChanged: () => void }) {
  const [busy, setBusy] = useState<'check' | 'apply' | 'delete' | null>(null);
  const [editing, setEditing] = useState(false);
  const isDrifted = s.kind === 'git' && !!s.available_git_sha && s.available_git_sha !== s.installed_git_sha;

  const handleDelete = async () => {
    if (!confirm(`Delete source "${s.label}"? This won't remove any blocks already imported from it — they stay in the library.`)) return;
    setBusy('delete');
    try {
      const session = await supabase.auth.getSession();
      const accessToken = session.data.session?.access_token;
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const res = await fetch(`${apiUrl}/api/modules/templates/sources/${s.id}`, {
        method: 'DELETE',
        headers: { Authorization: accessToken ? `Bearer ${accessToken}` : '' },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error?.message ?? `Delete failed (${res.status})`);
        return;
      }
      // Reset the collection's publish target back to internal — the
      // source we mirrored onto git_url is gone. Without this, the
      // publish gate would keep trying to write to a now-unreferenced
      // git URL on subsequent publishes.
      if (s.kind === 'git' && s.library_id) {
        const { error: collErr } = await supabase
          .from('newsletters_template_collections')
          .update({ git_provenance: 'internal', git_url: null })
          .eq('id', s.library_id);
        if (collErr) {
          // eslint-disable-next-line no-console
          console.warn('[newsletter-source] could not reset collection git config:', collErr);
        }
      }
      toast.success('Source deleted');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  };

  // Single "Update" action: re-apply the template (re-clones HEAD, upserts
  // block/brick/wrapper defs in one pass via the templates module's apply),
  // then keep this newsletter's block defs render_kind='react-email' so the
  // editor surfaces them all. Header/footer chrome flows through the same
  // apply now — the wrapper template lives at `wrappers/default.html` in the
  // repo and lands in `templates_wrappers`; no separate sync step needed.
  const handleUpdate = async () => {
    setBusy('apply');
    try {
      const session = await supabase.auth.getSession();
      const accessToken = session.data.session?.access_token;
      const auth = accessToken ? `Bearer ${accessToken}` : '';
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      let declCount = 0;

      const applyRes = await fetch(`${apiUrl}/api/modules/templates/sources/${s.id}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
      });
      const applyBody = await applyRes.json().catch(() => null);
      if (!applyRes.ok) {
        // Best-effort: a fully-declarative newsletter has no template.html
        // blocks to apply (its blocks live under blocks/ and load via
        // sync-declarative-blocks below), so a no-op/failed apply must not
        // short-circuit the rest of the Update.
        // eslint-disable-next-line no-console
        console.warn('[update] template apply skipped/failed (continuing)', applyBody);
      }

      if (s.library_id) {
        // (Removed: client-side PATCH that force-set render_kind='react-email'
        // for every block def in the library. It violated the
        // templates_block_defs_render_kind_component_id constraint when the
        // rows lacked a component_id, and it papered over the real issue —
        // the apply_source SQL never set render_kind in the first place.
        // Migration 026 fixes that at the source: every block/brick def
        // ingested from the source repo lands with render_kind='declarative'
        // + component_id=key, satisfying the constraint and routing the
        // blocks through the declarative renderer just like react-email
        // registry blocks.)

        // Pull declarative (html-ish) blocks + bricks from the repo.
        const declRes = await fetch(
          `${apiUrl}/api/admin/newsletters/collections/${s.library_id}/sync-declarative-blocks`,
          { method: 'POST', headers: { Authorization: auth } },
        );
        const declBody = (await declRes.json().catch(() => null)) as { synced?: number; bricksSynced?: number } | null;
        if (!declRes.ok) {
          // eslint-disable-next-line no-console
          console.warn('[update] declarative block sync failed', declBody);
        } else {
          declCount = (declBody?.synced ?? 0) + (declBody?.bricksSynced ?? 0);
        }
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
          <p className="text-xs text-[var(--gray-9)] mt-1 truncate">
            {s.url}{s.branch ? ` · branch ${s.branch}` : ''}{s.manifest_path ? ` · path ${s.manifest_path}` : ''}
          </p>
        )}
        {s.installed_git_sha && (
          <p className="text-xs text-[var(--gray-a11)] mt-0.5">
            Installed: <code>{s.installed_git_sha.slice(0, 8)}</code>
            {isDrifted && <> → available: <code className="text-[var(--amber-11)]">{s.available_git_sha.slice(0, 8)}</code></>}
          </p>
        )}
        {s.last_checked_at && (
          <p className="text-xs text-[var(--gray-a11)] mt-0.5">
            Last checked: {new Date(s.last_checked_at).toLocaleString()}
          </p>
        )}
        {s.last_check_error && (
          <p className="text-xs text-[var(--red-11)] mt-0.5">{s.last_check_error}</p>
        )}
      </div>
      {s.kind === 'git' && (
        <div className="flex flex-col gap-1.5 shrink-0">
          <Button
            variant={isDrifted ? 'solid' : 'outline'}
            size="1"
            onClick={handleUpdate}
            disabled={busy !== null}
            title="Pull the latest template from git: import block/wrapper changes and sync the header/footer links"
          >
            {busy === 'apply' ? 'Updating…' : isDrifted ? 'Update available' : 'Update'}
          </Button>
          <Button
            variant="outline"
            size="1"
            onClick={() => setEditing((v) => !v)}
            disabled={busy !== null}
          >
            {editing ? 'Cancel' : 'Edit'}
          </Button>
          <Button
            variant="outline"
            color="red"
            size="1"
            onClick={handleDelete}
            disabled={busy !== null}
          >
            {busy === 'delete' ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      )}
      {editing && s.kind === 'git' && (
        <div className="w-full mt-2 basis-full">
          <ConfigureGitSourceForm
            libraryId={s.library_id ?? ''}
            existing={s}
            onSaved={() => { setEditing(false); onChanged(); }}
          />
        </div>
      )}
    </li>
  );
}

/**
 * One-click seed-from-boilerplate button. Per spec-content-modules-git-
 * architecture §5: when no source is configured, the admin can clone the
 * canonical Gatewaze boilerplate (or the operator's override) with a
 * single click. POSTs to /libraries/:id/seed-from-boilerplate which
 * dereferences GATEWAZE_NEWSLETTER_BOILERPLATE_URL server-side.
 */
function SeedFromBoilerplateButton({ libraryId, onSeeded }: { libraryId: string; onSeeded: () => void }) {
  const [busy, setBusy] = useState(false);
  const handleClick = async () => {
    setBusy(true);
    try {
      const session = await supabase.auth.getSession();
      const accessToken = session.data.session?.access_token;
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const res = await fetch(`${apiUrl}/api/modules/templates/libraries/${libraryId}/seed-from-boilerplate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: accessToken ? `Bearer ${accessToken}` : '',
        },
        body: JSON.stringify({ host_kind: 'newsletter' }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error?.message ?? `Boilerplate seed failed (${res.status})`);
        return;
      }
      toast.success(`Imported ${body?.apply?.artifacts?.length ?? 0} template(s) from boilerplate`);
      onSeeded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Boilerplate seed failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="solid" onClick={handleClick} disabled={busy}>
      {busy ? 'Importing…' : 'Start from boilerplate'}
    </Button>
  );
}

/**
 * Inline form for connecting OR editing a git templates source.
 * Defaults to POST /api/modules/templates/sources (create flow). If
 * `existing` is passed, switches to PATCH /sources/:id (edit flow):
 * the form is pre-populated from the row, the token input is left
 * blank by design so the operator only sends a new PAT when they
 * want to rotate it, and the URL field is read-only because URL
 * changes effectively make a new source.
 */
function ConfigureGitSourceForm({
  libraryId,
  existing,
  onSaved,
}: {
  libraryId: string;
  existing?: TemplatesSourceRow;
  onSaved: () => void;
}) {
  const isEdit = !!existing;
  const [url, setUrl] = useState(existing?.url ?? '');
  const [branch, setBranch] = useState(existing?.branch ?? '');
  const [manifestPath, setManifestPath] = useState(existing?.manifest_path ?? '');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState(existing?.label ?? 'Theme repo');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) {
      toast.error('Repository URL is required');
      return;
    }
    setSubmitting(true);
    try {
      const session = await supabase.auth.getSession();
      const accessToken = session.data.session?.access_token;
      const endpoint = isEdit
        ? `/api/modules/templates/sources/${existing!.id}`
        : '/api/modules/templates/sources';
      // Edit path: PATCH only the fields the operator could have changed.
      // Leave token out unless they typed a new one (don't accidentally
      // clear the stored PAT when they leave the field blank).
      const body = isEdit
        ? {
            label: label.trim() || 'Theme repo',
            branch: branch.trim() || null,
            manifest_path: manifestPath.trim() || null,
            ...(token.trim() ? { token: token.trim() } : {}),
          }
        : {
            library_id: libraryId,
            kind: 'git',
            label: label.trim() || 'Theme repo',
            url: url.trim(),
            branch: branch.trim() || undefined,
            manifest_path: manifestPath.trim() || undefined,
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
      const respBody = await res.json().catch(() => null);
      if (!res.ok) {
        const message = respBody?.error?.message ?? `Request failed (${res.status})`;
        toast.error(message);
        return;
      }

      // Mirror the source's git URL onto the newsletter collection so
      // publish-to-git can write into it. templates_sources is where
      // theme files COME FROM; newsletters_template_collections.git_url
      // is where rendered editions GO. The common case is the same
      // repo, with theme on the `theme` branch and output on `publish`
      // — flip git_provenance to 'external' and record the URL so the
      // publish gate (api/publish-to-git.ts) lets the commit through.
      // The collection's git_branch keeps its 'publish' default from
      // migration 027. Failure here doesn't fail the source create —
      // operator can fix via the newsletter settings tab if needed.
      const { error: collErr } = await supabase
        .from('newsletters_template_collections')
        .update({
          git_provenance: 'external',
          git_url: url.trim(),
        })
        .eq('id', libraryId);
      if (collErr) {
        // eslint-disable-next-line no-console
        console.warn('[newsletter-source] could not sync git_url to collection:', collErr);
      }

      toast.success(
        isEdit
          ? 'Source updated'
          : `Connected — ${respBody?.apply?.artifacts?.length ?? 0} template(s) imported`,
      );
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save git source');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="p-4 border border-[var(--gray-a5)] rounded-lg space-y-3 mb-3 bg-[var(--gray-a2)]">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded bg-[var(--color-background)]"
            placeholder="Theme repo"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">Repository URL <span className="text-[var(--red-11)]">*</span></label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={isEdit}
            className="w-full px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded bg-[var(--color-background)] disabled:bg-[var(--gray-a3)] disabled:text-[var(--gray-10)] disabled:cursor-not-allowed"
            placeholder="https://github.com/owner/repo.git"
            required
            title={isEdit ? 'Repository URL is immutable; delete and reconnect to change it' : ''}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">Branch</label>
          <input
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded bg-[var(--color-background)]"
            placeholder="main"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">Templates path (optional)</label>
          <input
            type="text"
            value={manifestPath}
            onChange={(e) => setManifestPath(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded bg-[var(--color-background)]"
            placeholder="templates/email"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">
            Personal access token {isEdit ? '(leave blank to keep the current token)' : '(private repos only)'}
          </label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded bg-[var(--color-background)]"
            placeholder={isEdit ? 'ghp_… (only fill in to rotate the token)' : 'ghp_… (leave blank for public repos)'}
            autoComplete="off"
          />
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={submitting}>
          {submitting
            ? (isEdit ? 'Saving…' : 'Connecting…')
            : (isEdit ? 'Save changes' : 'Connect repository')}
        </Button>
      </div>
    </form>
  );
}
