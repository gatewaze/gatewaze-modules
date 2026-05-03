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

// Inline template tab — embeds the existing template management
function TemplateTabContent({ newsletterId, newsletterSlug }: { newsletterId: string; newsletterSlug: string }) {
  const navigate = useNavigate();
  const [blocks, setBlocks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // templates_block_defs uses `key` instead of legacy `block_type`. We
    // alias it back so the JSX below (and the route navigation) keeps
    // referencing block.block_type without further changes.
    supabase.from('templates_block_defs')
      .select('id, key, name, block_type:key')
      .eq('library_id', newsletterId)
      .order('key')
      .then(({ data }) => { setBlocks(data || []); setLoading(false); });
  }, [newsletterId]);

  if (loading) return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent-9)]" /></div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-[var(--gray-12)]">Block Templates</h2>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate(`/newsletters/templates/${newsletterSlug}/upload`)}>
            Upload HTML
          </Button>
        </div>
      </div>

      {blocks.length === 0 ? (
        <div className="text-center py-12 text-[var(--gray-9)]">
          <RectangleGroupIcon className="h-12 w-12 mx-auto mb-3 text-[var(--gray-8)]" />
          <p className="mb-2">No templates yet</p>
          <p className="text-sm">Upload an HTML template to get started.</p>
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
    </div>
  );
}
