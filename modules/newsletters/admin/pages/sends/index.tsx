import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  PaperAirplaneIcon,
  ClockIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { supabase } from '@/lib/supabase';

interface NewsletterSend {
  id: string;
  edition_id: string;
  subscription_list_id: string;
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled';
  scheduled_at: string | null;
  sent_at: string | null;
  total_recipients: number;
  delivered_count: number;
  failed_count: number;
  open_count: number;
  click_count: number;
  error_message: string | null;
  created_at: string;
  edition?: {
    id: string;
    edition_date: string;
    subject: string;
  };
}

const STATUS_CONFIG: Record<string, { color: string; icon: typeof CheckCircleIcon }> = {
  draft: { color: 'neutral', icon: ClockIcon },
  scheduled: { color: 'info', icon: ClockIcon },
  sending: { color: 'warning', icon: PaperAirplaneIcon },
  sent: { color: 'success', icon: CheckCircleIcon },
  failed: { color: 'error', icon: ExclamationCircleIcon },
  cancelled: { color: 'neutral', icon: ExclamationCircleIcon },
};

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function NewsletterSendsPage() {
  const navigate = useNavigate();
  const [sends, setSends] = useState<NewsletterSend[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSends();
  }, []);

  async function loadSends() {
    try {
      const { data, error } = await supabase
        .from('newsletter_sends')
        .select(`
          *,
          edition:newsletters_editions(id, edition_date, subject)
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setSends(data || []);
    } catch (error) {
      console.error('Error loading sends:', error);
      toast.error('Failed to load newsletter sends');
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <Page title="Newsletter Sends">
        <div className="flex items-center justify-center p-12">
          <LoadingSpinner />
        </div>
      </Page>
    );
  }

  return (
    <Page title="Newsletter Sends">
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Newsletter Sends
            </h1>
            <p className="text-[var(--gray-11)] mt-1">
              Track and manage newsletter deliveries
            </p>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <Card className="p-4">
            <p className="text-xs text-[var(--gray-10)] uppercase">Total Sends</p>
            <p className="text-2xl font-semibold text-[var(--gray-12)]">{sends.length}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-[var(--gray-10)] uppercase">Scheduled</p>
            <p className="text-2xl font-semibold text-[var(--accent-9)]">
              {sends.filter(s => s.status === 'scheduled').length}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-[var(--gray-10)] uppercase">Sent</p>
            <p className="text-2xl font-semibold text-[var(--green-9)]">
              {sends.filter(s => s.status === 'sent').length}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-[var(--gray-10)] uppercase">Failed</p>
            <p className="text-2xl font-semibold text-[var(--red-9)]">
              {sends.filter(s => s.status === 'failed').length}
            </p>
          </Card>
        </div>

        {/* Sends List */}
        <div className="space-y-2">
          {sends.map((send) => {
            const statusCfg = STATUS_CONFIG[send.status] || STATUS_CONFIG.draft;
            const StatusIcon = statusCfg.icon;

            return (
              <Card
                key={send.id}
                className="p-4 cursor-pointer hover:border-[var(--accent-8)] transition-colors"
                onClick={() => navigate(`/newsletters/sends/${send.id}`)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <StatusIcon className="w-5 h-5 text-[var(--gray-10)]" />
                    <div>
                      <p className="text-sm font-medium text-[var(--gray-12)]">
                        {send.edition?.subject || `Edition ${send.edition?.edition_date || 'Unknown'}`}
                      </p>
                      <p className="text-xs text-[var(--gray-10)]">
                        {formatDate(send.created_at)}
                        {send.scheduled_at && ` · Scheduled: ${formatDate(send.scheduled_at)}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right text-xs text-[var(--gray-10)]">
                      <p>{send.total_recipients} recipients</p>
                      {send.status === 'sent' && (
                        <p>{send.delivered_count} delivered · {send.open_count} opens</p>
                      )}
                    </div>
                    <Badge variant={statusCfg.color as any}>
                      {send.status}
                    </Badge>
                  </div>
                </div>
                {send.error_message && (
                  <p className="mt-2 text-xs text-[var(--red-9)]">{send.error_message}</p>
                )}
              </Card>
            );
          })}

          {sends.length === 0 && (
            <div className="text-center py-12 text-[var(--gray-10)]">
              <PaperAirplaneIcon className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>No newsletter sends yet</p>
              <p className="text-sm mt-1">Send a newsletter from the edition editor</p>
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}
