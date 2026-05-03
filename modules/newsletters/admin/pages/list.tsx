import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import {
  PlusIcon,
  EnvelopeIcon,
  UsersIcon,
  DocumentTextIcon,
  ChartBarIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { supabase } from '@/lib/supabase';
import NewsletterSetupWizard from '../components/NewsletterSetupWizard';

interface Newsletter {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  content_category: string | null;
  accent_color: string | null;
  from_name: string | null;
  from_email: string | null;
  setup_complete: boolean;
  list_id: string | null;
  created_at: string;
  edition_count: number;
  subscriber_count: number;
  last_send_date: string | null;
}

export default function NewsletterListPage() {
  const navigate = useNavigate();
  const [newsletters, setNewsletters] = useState<Newsletter[]>([]);
  const [loading, setLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data: collections, error } = await supabase
        .from('newsletters_template_collections')
        .select('*')
        .order('name');

      if (error) throw error;

      // Enrich with edition counts and subscriber counts
      const enriched = await Promise.all((collections || []).map(async (col: any) => {
        const { count: editionCount } = await supabase
          .from('newsletters_editions')
          .select('id', { count: 'exact', head: true })
          .eq('collection_id', col.id);

        let subscriberCount = 0;
        if (col.list_id) {
          try {
            const { count } = await supabase
              .from('list_subscriptions')
              .select('id', { count: 'exact', head: true })
              .eq('list_id', col.list_id)
              .eq('subscribed', true);
            subscriberCount = count || 0;
          } catch { /* lists module may not be installed */ }
        }

        // Get last send date
        let lastSendDate = null;
        const { data: lastSend } = await supabase
          .from('newsletter_sends')
          .select('completed_at')
          .eq('status', 'sent')
          .order('completed_at', { ascending: false })
          .limit(1);
        if (lastSend?.[0]) lastSendDate = lastSend[0].completed_at;

        return {
          ...col,
          edition_count: editionCount || 0,
          subscriber_count: subscriberCount,
          last_send_date: lastSendDate,
        };
      }));

      setNewsletters(enriched);
    } catch (err) {
      console.error('Error loading newsletters:', err);
      toast.error('Failed to load newsletters');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <Page title="Newsletters">
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Newsletters</h1>
            <p className="text-[var(--gray-11)] mt-1">Create and manage your newsletter publications</p>
          </div>
          <Button variant="solid" onClick={() => setShowWizard(true)}>
            <PlusIcon className="h-4 w-4 mr-1" /> Create Newsletter
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" />
          </div>
        ) : newsletters.length === 0 ? (
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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {newsletters.map(nl => (
              <Card
                key={nl.id}
                className="p-5 cursor-pointer hover:shadow-md transition-shadow border-l-4"
                style={{ borderLeftColor: nl.accent_color || 'var(--accent-9)' }}
                onClick={() => navigate(`/newsletters/${nl.slug}`)}
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-semibold text-[var(--gray-12)] text-lg">{nl.name}</h3>
                    {nl.description && (
                      <p className="text-sm text-[var(--gray-9)] mt-0.5 line-clamp-1">{nl.description}</p>
                    )}
                  </div>
                  {!nl.setup_complete && (
                    <Badge variant="soft" color="orange" size="1">Setup needed</Badge>
                  )}
                </div>

                <div className="flex items-center gap-3 flex-wrap mb-3">
                  {nl.content_category && (
                    <Badge variant="soft" color="blue" size="1">{nl.content_category}</Badge>
                  )}
                  {nl.from_email && (
                    <span className="text-xs text-[var(--gray-9)]">{nl.from_email}</span>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-3 pt-3 border-t border-[var(--gray-a4)]">
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 text-[var(--gray-9)]">
                      <DocumentTextIcon className="h-3.5 w-3.5" />
                      <span className="text-sm font-medium text-[var(--gray-12)]">{nl.edition_count}</span>
                    </div>
                    <p className="text-[10px] text-[var(--gray-9)]">Editions</p>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 text-[var(--gray-9)]">
                      <UsersIcon className="h-3.5 w-3.5" />
                      <span className="text-sm font-medium text-[var(--gray-12)]">{nl.subscriber_count}</span>
                    </div>
                    <p className="text-[10px] text-[var(--gray-9)]">Subscribers</p>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 text-[var(--gray-9)]">
                      <ChartBarIcon className="h-3.5 w-3.5" />
                      <span className="text-sm font-medium text-[var(--gray-12)]">—</span>
                    </div>
                    <p className="text-[10px] text-[var(--gray-9)]">Open rate</p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <NewsletterSetupWizard
        isOpen={showWizard}
        onClose={() => { setShowWizard(false); load(); }}
      />
    </Page>
  );
}
