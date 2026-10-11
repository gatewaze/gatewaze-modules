import { useState, useEffect, useCallback } from 'react';
import { BuiltInWrapperCard } from '../components/BuiltInWrapperCard';
import { TemplateSourcesPanel } from '../components/templates/TemplateSourcesPanel';
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
import { useAdminScope } from '@/hooks/usePermissions';
import { NewsletterDetailsForm } from '../components/NewsletterDetailsForm';
import { DeleteNewsletterCard } from '../components/DeleteNewsletterCard';
import { PublishingSettings } from '../components/PublishingSettings';
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
  // Active sends across all editions of this collection — drives the hero
  // "Sending" / "scheduled" notification. Empty unless something is in flight.
  const [activeSends, setActiveSends] = useState<Array<{ status: string; scheduled_at: string | null }>>([]);

  // Publication settings (Settings + Template) are super_admin-only; admins
  // work within editions. A non-super-admin hitting /details or /template by
  // URL falls back to the default tab because those ids aren't valid for them.
  const { isSuperAdmin } = useAdminScope();
  const validTabs: NewsletterTab[] = [
    ...(isSuperAdmin ? ['details' as NewsletterTab, 'template' as NewsletterTab] : []),
    'editions',
    ...(hasBulkEmailing ? ['replies' as NewsletterTab, 'stats' as NewsletterTab] : []),
  ];
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

  // Poll-free active-send watcher: load any scheduled/sending sends for this
  // collection's editions, and refetch whenever a newsletter_sends row changes
  // (status flips through scheduled → sending → sent/cancelled).
  const collectionId = newsletter?.id;
  useEffect(() => {
    if (!collectionId) return;
    let cancelled = false;
    const fetchActive = async () => {
      const { data: eds } = await supabase
        .from('newsletters_editions')
        .select('id')
        .eq('collection_id', collectionId);
      const ids = (eds ?? []).map((e: { id: string }) => e.id);
      if (ids.length === 0) { if (!cancelled) setActiveSends([]); return; }
      const { data } = await supabase
        .from('newsletter_sends')
        .select('status, scheduled_at')
        .in('edition_id', ids)
        .in('status', ['scheduled', 'sending', 'cancelling'])
        .order('scheduled_at', { ascending: true, nullsFirst: false });
      if (!cancelled) setActiveSends(data ?? []);
    };
    fetchActive();
    const channel = supabase
      .channel(`nl-active-sends-${collectionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'newsletter_sends' }, fetchActive)
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [collectionId]);

  if (loading) {
    return <Page title="Loading..."><div className="flex items-center justify-center h-64"><LoadingSpinner /></div></Page>;
  }

  if (!newsletter) {
    return <Page title="Not Found"><div className="p-6 text-center text-[var(--gray-9)]">Newsletter not found</div></Page>;
  }

  const ic = 'size-4';

  const tabs: Tab[] = [
    ...(isSuperAdmin ? [
      { id: 'details', label: 'Settings', icon: <Cog6ToothIcon className={ic} /> },
      { id: 'template', label: 'Template', icon: <RectangleGroupIcon className={ic} /> },
    ] : []),
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
            {(() => {
              const sending = activeSends.some((s) => s.status === 'sending' || s.status === 'cancelling');
              const scheduled = activeSends.filter((s) => s.status === 'scheduled').length;
              if (sending) {
                return (
                  <Badge variant="solid" color="blue" size="1">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-white mr-1.5 animate-pulse" />
                    Sending now
                  </Badge>
                );
              }
              if (scheduled > 0) {
                return (
                  <Badge variant="soft" color="amber" size="1">
                    {scheduled === 1 ? 'Send scheduled' : `${scheduled} sends scheduled`}
                  </Badge>
                );
              }
              return null;
            })()}
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
      {activeTab === 'details' && isSuperAdmin && (
        <div className="py-2 grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <div className="space-y-6">
            <NewsletterDetailsForm newsletter={newsletter} onSave={loadNewsletter} />
            <DeleteNewsletterCard newsletterId={newsletter.id} newsletterName={newsletter.name} />
          </div>
          <div className="space-y-6">
            <PublishingSettings collectionId={newsletter.id} />
            <ViewOnlineSettings collectionId={newsletter.id} />
          </div>
        </div>
      )}

      {activeTab === 'template' && isSuperAdmin && (
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

/**
 * Template tab: the wrapper editions render in (built-in plain email or
 * the repo's wrappers/default.html) and the template repo itself. The repo
 * for PUBLISHING editions is separate, on the Settings tab.
 */
function TemplateTabContent({ newsletterId, newsletterSlug }: { newsletterId: string; newsletterSlug: string }) {
  return (
    <div className="space-y-8">
      <BuiltInWrapperCard newsletterId={newsletterId} />
      <TemplateSourcesPanel
        libraryId={newsletterId}
        hostKind="newsletter"
        uploadHref={`/newsletters/templates/${newsletterSlug}/upload`}
        blockHref={(blockType) => `/newsletters/templates/${newsletterSlug}/blocks/${blockType}`}
      />
    </div>
  );
}
