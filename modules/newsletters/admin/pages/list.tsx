import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { PlusIcon, EnvelopeIcon, DocumentPlusIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Button, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { RowActions } from '@/components/shared/table/RowActions';
import { supabase } from '@/lib/supabase';
import { useAdminScope } from '@/hooks/usePermissions';
import NewsletterSetupWizard from '../components/NewsletterSetupWizard';
import { PickPublicationModal } from '../components/PickPublicationModal';
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
  const [showPickPublication, setShowPickPublication] = useState(false);

  // Only super_admins create publications (and edit their settings); admins
  // create editions. The Create button adapts: a menu for super_admins, a
  // straight-to-edition action for everyone else.
  const { isSuperAdmin: canCreatePublication } = useAdminScope();

  const goToNewEdition = (pub: { id: string; slug: string }) =>
    navigate(`/newsletters/${pub.slug}/editions/new?collection=${pub.id}`);

  const handleCreateEdition = () => {
    if (cards.length === 1) { goToNewEdition(cards[0]); return; } // nothing to pick
    setShowPickPublication(true);
  };

  const load = useCallback(async () => {
    try {
      const { data: collections, error } = await supabase
        .from('newsletters_template_collections')
        .select('*')
        .order('sort_order')
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
          sort_order: Number(col.sort_order ?? 0),
          edition_count: editionCount,
          subscriber_count: subscriberCount,
          avgOpenRate: sumDelivered > 0 ? sumOpens / sumDelivered : null,
          avgClickRate: sumDelivered > 0 ? sumClicks / sumDelivered : null,
          totalSent: eds.reduce((a, e) => a + e.sent, 0),
          // trend series, oldest → newest, sent editions only
          sparkSent: sentEds.slice().reverse().map((e) => e.sent),
          sparkOpen: sentEds.slice().reverse().map((e) => e.opens / e.delivered),
          sparkClick: sentEds.slice().reverse().map((e) => e.clicks / e.delivered),
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

  // Reorder publications (super_admin). Swap the two neighbours in the current
  // visual order, then renumber every card to its position (×10) — writing only
  // the rows whose value actually changes — so ties from the default 0 can't
  // make a move a no-op. Dashboard and portal both order by sort_order.
  const handleMove = async (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= cards.length) return;
    const next = cards.slice();
    [next[index], next[j]] = [next[j], next[index]];
    try {
      const writes = next
        .map((c, k) => ({ id: c.id, want: (k + 1) * 10, have: c.sort_order }))
        .filter((w) => w.want !== w.have)
        .map((w) => supabase.from('newsletters_template_collections').update({ sort_order: w.want }).eq('id', w.id));
      const results = await Promise.all(writes);
      const failed = results.find((r) => r.error);
      if (failed?.error) throw failed.error;
      setCards(next.map((c, k) => ({ ...c, sort_order: (k + 1) * 10 })));
    } catch (err) {
      console.error('Error reordering publications:', err);
      toast.error('Failed to reorder publications');
    }
  };

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
          canCreatePublication ? (
            <RowActions
              trigger={
                <Button variant="solid">
                  <PlusIcon className="h-4 w-4 mr-1" /> Create
                </Button>
              }
              actions={[
                { label: 'New publication', icon: <EnvelopeIcon className="size-4" />, onClick: () => setShowWizard(true) },
                { label: 'New edition', icon: <DocumentPlusIcon className="size-4" />, onClick: handleCreateEdition, disabled: cards.length === 0 },
              ]}
            />
          ) : (
            <Button variant="solid" onClick={handleCreateEdition} disabled={cards.length === 0}>
              <PlusIcon className="h-4 w-4 mr-1" /> Create
            </Button>
          )
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
            {canCreatePublication ? (
              <>
                <p className="text-[var(--gray-11)] mb-6 max-w-md mx-auto">
                  Create your first publication to start building and sending editions to your subscribers.
                </p>
                <Button variant="solid" onClick={() => setShowWizard(true)}>
                  <PlusIcon className="h-4 w-4 mr-1" /> Create your first publication
                </Button>
              </>
            ) : (
              <p className="text-[var(--gray-11)] max-w-md mx-auto">
                A super admin needs to create a publication before editions can be added.
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {cards.map((c, i) => (
              <NewsletterDashboardCard
                key={c.id}
                data={c}
                onMoveUp={canCreatePublication && i > 0 ? () => handleMove(i, -1) : undefined}
                onMoveDown={canCreatePublication && i < cards.length - 1 ? () => handleMove(i, 1) : undefined}
                canReorder={canCreatePublication}
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

      {showPickPublication && (
        <PickPublicationModal
          isOpen
          onClose={() => setShowPickPublication(false)}
          publications={cards.map((c) => ({
            id: c.id, name: c.name, slug: c.slug,
            content_category: c.content_category, accent_color: c.accent_color, edition_count: c.edition_count,
          }))}
          onPick={(pub) => { setShowPickPublication(false); goToNewEdition(pub); }}
        />
      )}
    </Page>
  );
}
