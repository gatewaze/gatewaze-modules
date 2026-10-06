import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { PlusIcon, EnvelopeIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Button, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { supabase } from '@/lib/supabase';
import NewsletterSetupWizard from '../components/NewsletterSetupWizard';
import {
  NewsletterDashboardCard,
  type NewsletterCardData,
  type DashboardEdition,
} from '../components/NewsletterDashboardCard';
import { duplicateEdition } from '../lib/duplicateEdition';

// How many recent editions to pull per newsletter for metrics + the sparkline;
// only the latest 3 are shown in the list.
const RECENT_EDITIONS = 8;

interface EngagementRow {
  edition_id: string;
  sent: number;
  delivered: number;
  unique_opens: number;
  unique_clicks: number;
}

export default function NewsletterListPage() {
  const navigate = useNavigate();
  const [cards, setCards] = useState<NewsletterCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data: collections, error } = await supabase
        .from('newsletters_template_collections')
        .select('*')
        .order('name');
      if (error) throw error;
      const cols = collections || [];

      // Per-newsletter: recent editions, total count, subscriber count — in parallel.
      const perCol = await Promise.all(cols.map(async (col: Record<string, unknown>) => {
        const colId = col.id as string;
        const [editionsRes, countRes] = await Promise.all([
          supabase
            .from('newsletters_editions')
            .select('id, title, edition_date, status, publish_state, collection_id, preheader, content_category, metadata')
            .eq('collection_id', colId)
            .order('edition_date', { ascending: false })
            .limit(RECENT_EDITIONS),
          supabase
            .from('newsletters_editions')
            .select('id', { count: 'exact', head: true })
            .eq('collection_id', colId),
        ]);

        let subscriberCount = 0;
        if (col.list_id) {
          try {
            const { count } = await supabase
              .from('list_subscriptions')
              .select('id', { count: 'exact', head: true })
              .eq('list_id', col.list_id as string)
              .eq('subscribed', true);
            subscriberCount = count || 0;
          } catch { /* lists module may not be installed */ }
        }

        return {
          col,
          editions: (editionsRes.data || []) as Array<Record<string, unknown>>,
          editionCount: countRes.count || 0,
          subscriberCount,
        };
      }));

      // One batched engagement lookup for every edition we're about to show.
      const allIds = perCol.flatMap((p) => p.editions.map((e) => e.id as string));
      const engById = new Map<string, EngagementRow>();
      for (let i = 0; i < allIds.length; i += 25) {
        const chunk = allIds.slice(i, i + 25);
        const { data: eng } = await supabase.rpc('newsletter_edition_engagement', { p_edition_ids: chunk });
        for (const r of (eng || []) as EngagementRow[]) engById.set(r.edition_id, r);
      }

      const built: NewsletterCardData[] = perCol.map(({ col, editions, editionCount, subscriberCount }) => {
        const eds: DashboardEdition[] = editions.map((e) => {
          const g = engById.get(e.id as string);
          const sent = Number(g?.sent ?? 0);
          const delivered = Number(g?.delivered ?? 0);
          return {
            id: e.id as string,
            title: (e.title as string) ?? null,
            edition_date: e.edition_date as string,
            status: (e.status as string) ?? null,
            publish_state: (e.publish_state as string) ?? null,
            collection_id: (e.collection_id as string) ?? null,
            preheader: (e.preheader as string) ?? null,
            content_category: (e.content_category as string) ?? null,
            metadata: (e.metadata as Record<string, unknown>) ?? null,
            sent,
            delivered,
            opens: Number(g?.unique_opens ?? 0),
            clicks: Number(g?.unique_clicks ?? 0),
            hasData: delivered > 0 || sent > 0,
          };
        });

        const sentEds = eds.filter((e) => e.delivered > 0);
        const sumDelivered = sentEds.reduce((a, e) => a + e.delivered, 0);
        const sumOpens = sentEds.reduce((a, e) => a + e.opens, 0);
        const sumClicks = sentEds.reduce((a, e) => a + e.clicks, 0);

        return {
          id: col.id as string,
          name: col.name as string,
          slug: col.slug as string,
          description: (col.description as string) ?? null,
          content_category: (col.content_category as string) ?? null,
          accent_color: (col.accent_color as string) ?? null,
          from_email: (col.from_email as string) ?? null,
          setup_complete: Boolean(col.setup_complete),
          edition_count: editionCount,
          subscriber_count: subscriberCount,
          avgOpenRate: sumDelivered > 0 ? sumOpens / sumDelivered : null,
          avgClickRate: sumDelivered > 0 ? sumClicks / sumDelivered : null,
          totalSent: eds.reduce((a, e) => a + e.sent, 0),
          // oldest → newest, sent editions only
          sparkline: sentEds.slice().reverse().map((e) => e.opens / e.delivered),
          latestEditions: eds.slice(0, 3),
        };
      });

      setCards(built);
    } catch (err) {
      console.error('Error loading newsletters:', err);
      toast.error('Failed to load newsletters');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDuplicate = async (ed: DashboardEdition) => {
    try {
      await duplicateEdition(ed);
      toast.success('Edition duplicated');
      load();
    } catch (err) {
      console.error('Error duplicating edition:', err);
      toast.error('Failed to duplicate edition');
    }
  };

  return (
    <Page title="Newsletters">
      <WorkspaceLayout
        title="Newsletters"
        actions={
          <Button variant="solid" onClick={() => setShowWizard(true)}>
            <PlusIcon className="h-4 w-4 mr-1" /> Create Newsletter
          </Button>
        }
      >
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" />
          </div>
        ) : cards.length === 0 ? (
          <div className="text-center py-16">
            <EnvelopeIcon className="h-16 w-16 text-[var(--gray-8)] mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-[var(--gray-12)] mb-2">No newsletters yet</h2>
            <p className="text-[var(--gray-11)] mb-6 max-w-md mx-auto">
              Create your first newsletter to start building and sending email campaigns to your subscribers.
            </p>
            <Button variant="solid" onClick={() => setShowWizard(true)}>
              <PlusIcon className="h-4 w-4 mr-1" /> Create Your First Newsletter
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {cards.map((c) => (
              <NewsletterDashboardCard
                key={c.id}
                data={c}
                onOpen={() => navigate(`/newsletters/${c.slug}`)}
                onViewAllEditions={() => navigate(`/newsletters/${c.slug}/editions`)}
                onEditEdition={(id) => navigate(`/newsletters/${c.slug}/editions/${id}`)}
                onDuplicateEdition={handleDuplicate}
              />
            ))}
          </div>
        )}
      </WorkspaceLayout>

      <NewsletterSetupWizard
        isOpen={showWizard}
        onClose={() => { setShowWizard(false); load(); }}
      />
    </Page>
  );
}
