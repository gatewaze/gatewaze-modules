import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  ArrowLeftIcon,
  Cog6ToothIcon,
  RectangleGroupIcon,
  DocumentTextIcon,
  ChartBarIcon,
  DocumentArrowDownIcon,
  ChatBubbleLeftRightIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Page } from '@/components/shared/Page';
import { Badge, Button } from '@/components/ui';
import { Tabs } from '@/components/ui';
import type { Tab } from '@/components/ui/Tabs';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { supabase } from '@/lib/supabase';
import { useHasModule } from '@/hooks/useModuleFeature';
import { NewsletterDetailsForm } from '../components/NewsletterDetailsForm';
import { NewsletterStatsTab } from '../components/NewsletterStatsTab';
import { NewsletterRepliesTab } from '../components/NewsletterRepliesTab';
import { GDocImportTab } from '../components/GDocImportTab';
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

type NewsletterTab = 'details' | 'template' | 'editions' | 'import' | 'replies' | 'stats';

export default function NewsletterDetailPage() {
  const { slug, tab: tabFromUrl } = useParams<{ slug: string; tab?: string }>();
  const navigate = useNavigate();
  const hasBulkEmailing = useHasModule('bulk-emailing');

  const [newsletter, setNewsletter] = useState<Newsletter | null>(null);
  const [loading, setLoading] = useState(true);

  const validTabs: NewsletterTab[] = ['details', 'template', 'editions', 'import', ...(hasBulkEmailing ? ['replies' as NewsletterTab, 'stats' as NewsletterTab] : [])];
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

  const accentColor = newsletter.accent_color || '#00a2c7';
  const ic = 'size-4';

  const tabs: Tab[] = [
    { id: 'details', label: 'Details', icon: <Cog6ToothIcon className={ic} /> },
    { id: 'template', label: 'Template', icon: <RectangleGroupIcon className={ic} /> },
    { id: 'editions', label: 'Editions', icon: <DocumentTextIcon className={ic} /> },
    { id: 'import', label: 'Import', icon: <DocumentArrowDownIcon className={ic} /> },
    ...(hasBulkEmailing ? [
      { id: 'replies', label: 'Replies', icon: <ChatBubbleLeftRightIcon className={ic} /> },
      { id: 'stats', label: 'Stats', icon: <ChartBarIcon className={ic} /> },
    ] : []),
  ];

  return (
    <Page title={newsletter.name}>
      {/* Hero Header */}
      <div
        className="relative -mx-(--margin-x) -mt-(--margin-x) overflow-hidden"
        style={{ background: `linear-gradient(135deg, #1a1a2e 0%, ${accentColor}30 50%, #1a1a2e 100%)` }}
      >
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 to-black/60 pointer-events-none" />
        <div className="relative" style={{ padding: '1.5rem calc(var(--margin-x) + 1.5rem) 1.75rem' }}>
          <button
            onClick={() => navigate('/newsletters')}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-white/90 backdrop-blur-md border border-white/40 text-gray-900 shadow-sm hover:bg-white transition-colors mb-3"
          >
            <ArrowLeftIcon className="w-4 h-4" /> Back
          </button>
          <h1 className="text-2xl md:text-3xl lg:text-4xl font-bold text-white mb-2">{newsletter.name}</h1>
          <div className="flex items-center gap-3 flex-wrap">
            {newsletter.content_category && (
              <span className="px-3 py-1.5 bg-white/10 backdrop-blur-sm rounded-lg text-sm text-white/90">{newsletter.content_category}</span>
            )}
            <span className="px-3 py-1.5 bg-white/10 backdrop-blur-sm rounded-lg text-sm text-white/90">
              {newsletter.edition_count || 0} edition{newsletter.edition_count !== 1 ? 's' : ''}
            </span>
            {newsletter.subscriber_count != null && (
              <span className="px-3 py-1.5 bg-white/10 backdrop-blur-sm rounded-lg text-sm text-white/90">
                {newsletter.subscriber_count} subscriber{newsletter.subscriber_count !== 1 ? 's' : ''}
              </span>
            )}
            {!newsletter.setup_complete && (
              <Badge variant="soft" color="orange" size="1">Setup incomplete</Badge>
            )}
          </div>
        </div>
      </div>

      {/* Tab Bar */}
      <div className="-mx-(--margin-x)">
        <Tabs fullWidth value={activeTab} onChange={handleTabChange} tabs={tabs} />
      </div>

      {/* Tab Content */}
      {activeTab === 'details' && (
        <div className="-mx-(--margin-x) py-6" style={{ padding: '1.5rem calc(var(--margin-x) + 1.5rem)' }}>
          <NewsletterDetailsForm newsletter={newsletter} onSave={loadNewsletter} />
        </div>
      )}

      {activeTab === 'template' && (
        <div className="-mx-(--margin-x) py-6" style={{ padding: '1.5rem calc(var(--margin-x) + 1.5rem)' }}>
          <TemplateTabContent newsletterId={newsletter.id} newsletterSlug={newsletter.slug} />
        </div>
      )}

      {activeTab === 'editions' && (
        <div className="-mx-(--margin-x) py-6" style={{ padding: '1.5rem calc(var(--margin-x) + 1.5rem)' }}>
          <EditorTab newsletterId={newsletter.id} newsletterSlug={newsletter.slug} setupComplete={newsletter.setup_complete} />
        </div>
      )}

      {activeTab === 'import' && (
        <div className="-mx-(--margin-x) py-6" style={{ padding: '1.5rem calc(var(--margin-x) + 1.5rem)' }}>
          <GDocImportTab newsletterId={newsletter.id} newsletterSlug={newsletter.slug} />
        </div>
      )}

      {activeTab === 'replies' && hasBulkEmailing && (
        <div className="-mx-(--margin-x) py-6" style={{ padding: '1.5rem calc(var(--margin-x) + 1.5rem)' }}>
          <NewsletterRepliesTab newsletterId={newsletter.id} />
        </div>
      )}

      {activeTab === 'stats' && hasBulkEmailing && (
        <div className="-mx-(--margin-x) py-6" style={{ padding: '1.5rem calc(var(--margin-x) + 1.5rem)' }}>
          <NewsletterStatsTab newsletterId={newsletter.id} />
        </div>
      )}
    </Page>
  );
}

/** Narrow shape for the templates_sources rows we read in this tab. Mirrors
 *  the SELECT in `reload()` below — keep in sync if columns change. */
interface TemplatesSourceRow {
  id: string;
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
  const [showGitForm, setShowGitForm] = useState(false);

  const reload = useCallback(async () => {
    const [blocksRes, sourcesRes] = await Promise.all([
      // templates_block_defs uses `key`; alias it back so the click navigation
      // can keep referencing block.block_type.
      supabase.from('templates_block_defs')
        .select('id, key, name, block_type:key')
        .eq('library_id', newsletterId)
        .order('key'),
      supabase.from('templates_sources')
        .select('id, kind, label, status, url, branch, manifest_path, last_applied_sha, last_check_error, created_at')
        .eq('library_id', newsletterId)
        .order('created_at', { ascending: false }),
    ]);
    setBlocks(blocksRes.data || []);
    setSources(sourcesRes.data || []);
    setLoading(false);
  }, [newsletterId]);

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
      {/* Source section — git repo / uploads provenance */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold text-[var(--gray-12)]">Source</h2>
            <p className="text-xs text-[var(--gray-9)] mt-0.5">
              Where this newsletter&apos;s templates come from. Connect a git repo for version-controlled templates, or upload a one-off HTML file.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShowGitForm((v) => !v)}>
              {showGitForm ? 'Cancel' : 'Connect git repo'}
            </Button>
            <Button variant="outline" onClick={() => navigate(`/newsletters/templates/${newsletterSlug}/upload`)}>
              Upload HTML
            </Button>
          </div>
        </div>

        {showGitForm && (
          <ConfigureGitSourceForm
            libraryId={newsletterId}
            onSaved={() => { setShowGitForm(false); reload(); }}
          />
        )}

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
        <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-3">Block Templates</h2>
        {blocks.length === 0 ? (
          <div className="text-center py-12 text-[var(--gray-9)]">
            <RectangleGroupIcon className="h-12 w-12 mx-auto mb-3 text-[var(--gray-8)]" />
            <p className="mb-2">No templates yet</p>
            <p className="text-sm mb-4">Connect a git repo above, upload an HTML template, or start from the Gatewaze boilerplate.</p>
            <SeedFromBoilerplateButton libraryId={newsletterId} onSeeded={reload} />
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {blocks.map(block => (
              <div
                key={block.id}
                className="p-4 border border-[var(--gray-a5)] rounded-lg hover:bg-[var(--gray-a2)] cursor-pointer transition-colors"
                onClick={() => navigate(`/newsletters/templates/${newsletterSlug}/blocks/${block.block_type}`)}
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
  const [busy, setBusy] = useState<'check' | 'apply' | null>(null);
  const isDrifted = s.kind === 'git' && !!s.available_git_sha && s.available_git_sha !== s.installed_git_sha;

  const callRoute = async (path: string, label: string) => {
    setBusy(label === 'Checking…' ? 'check' : 'apply');
    try {
      const session = await supabase.auth.getSession();
      const accessToken = session.data.session?.access_token;
      const res = await fetch(`/api/modules/templates/sources/${s.id}/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: accessToken ? `Bearer ${accessToken}` : '',
        },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error?.message ?? `Request failed (${res.status})`);
        return;
      }
      toast.success(label === 'Checking…' ? 'Source checked' : 'Applied');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="p-3 border border-[var(--gray-a5)] rounded-lg flex items-start justify-between gap-3">
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
            variant="outline"
            size="1"
            onClick={() => callRoute('check', 'Checking…')}
            disabled={busy !== null}
          >
            {busy === 'check' ? 'Checking…' : 'Check now'}
          </Button>
          {isDrifted && (
            <Button
              variant="solid"
              size="1"
              onClick={() => callRoute('apply', 'Applying…')}
              disabled={busy !== null}
            >
              {busy === 'apply' ? 'Applying…' : 'Apply'}
            </Button>
          )}
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
      const res = await fetch(`/api/modules/templates/libraries/${libraryId}/seed-from-boilerplate`, {
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
 * Inline form for connecting a git repo as a templates source.
 * Calls POST /api/modules/templates/sources with kind='git'.
 */
function ConfigureGitSourceForm({ libraryId, onSaved }: { libraryId: string; onSaved: () => void }) {
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [manifestPath, setManifestPath] = useState('');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('Theme repo');
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
      const res = await fetch('/api/modules/templates/sources', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: accessToken ? `Bearer ${accessToken}` : '',
        },
        body: JSON.stringify({
          library_id: libraryId,
          kind: 'git',
          label: label.trim() || 'Theme repo',
          url: url.trim(),
          branch: branch.trim() || undefined,
          manifest_path: manifestPath.trim() || undefined,
          token: token.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const message = body?.error?.message ?? `Request failed (${res.status})`;
        toast.error(message);
        return;
      }
      toast.success(`Connected — ${body?.apply?.artifacts?.length ?? 0} template(s) imported`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to connect git source');
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
            className="w-full px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded bg-[var(--color-background)]"
            placeholder="https://github.com/owner/repo.git"
            required
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
          <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">Personal access token (private repos only)</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded bg-[var(--color-background)]"
            placeholder="ghp_… (leave blank for public repos)"
            autoComplete="off"
          />
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Connecting…' : 'Connect repository'}
        </Button>
      </div>
    </form>
  );
}
