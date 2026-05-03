import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  PaperAirplaneIcon,
  XMarkIcon,
  ArrowLeftIcon,
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
  bounce_count: number;
  unsubscribe_count: number;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  edition?: {
    id: string;
    edition_date: string;
    subject: string;
    preheader: string;
  };
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SendDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [send, setSend] = useState<NewsletterSend | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (id) loadSend();
  }, [id]);

  async function loadSend() {
    try {
      const { data, error } = await supabase
        .from('newsletter_sends')
        .select(`
          *,
          edition:newsletters_editions(id, edition_date, subject, preheader)
        `)
        .eq('id', id)
        .single();

      if (error) throw error;
      setSend(data);
    } catch (error) {
      console.error('Error loading send:', error);
      toast.error('Failed to load send details');
    } finally {
      setLoading(false);
    }
  }

  async function handleCancel() {
    if (!send || !confirm('Cancel this scheduled send?')) return;

    try {
      const { error } = await supabase
        .from('newsletter_sends')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', send.id);

      if (error) throw error;
      toast.success('Send cancelled');
      loadSend();
    } catch (error) {
      console.error('Error cancelling send:', error);
      toast.error('Failed to cancel send');
    }
  }

  async function handleRetry() {
    if (!send || !confirm('Retry sending this newsletter?')) return;

    try {
      const { error } = await supabase
        .from('newsletter_sends')
        .update({
          status: 'scheduled',
          error_message: null,
          scheduled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', send.id);

      if (error) throw error;
      toast.success('Send rescheduled');
      loadSend();
    } catch (error) {
      console.error('Error retrying send:', error);
      toast.error('Failed to retry send');
    }
  }

  if (loading) {
    return (
      <Page title="Send Details">
        <div className="flex items-center justify-center p-12">
          <LoadingSpinner />
        </div>
      </Page>
    );
  }

  if (!send) {
    return (
      <Page title="Send Not Found">
        <div className="p-6 text-center text-[var(--gray-10)]">Send not found</div>
      </Page>
    );
  }

  const deliveryRate = send.total_recipients > 0
    ? ((send.delivered_count / send.total_recipients) * 100).toFixed(1)
    : '0';
  const openRate = send.delivered_count > 0
    ? ((send.open_count / send.delivered_count) * 100).toFixed(1)
    : '0';
  const clickRate = send.delivered_count > 0
    ? ((send.click_count / send.delivered_count) * 100).toFixed(1)
    : '0';

  return (
    <Page title="Send Details">
      <div className="p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <button
              onClick={() => navigate('/newsletters/sends')}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-[var(--gray-a3)] border border-[var(--gray-a5)] text-[var(--gray-11)] hover:bg-[var(--gray-a4)] transition-colors mb-2"
            >
              <ArrowLeftIcon className="w-4 h-4" /> Back
            </button>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              {send.edition?.subject || 'Newsletter Send'}
            </h1>
            <p className="text-sm text-[var(--gray-10)]">
              Created {formatDate(send.created_at)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {send.status === 'scheduled' && (
              <Button variant="ghost" onClick={handleCancel}>
                <XMarkIcon className="w-4 h-4 mr-1" />
                Cancel
              </Button>
            )}
            {send.status === 'failed' && (
              <Button variant="primary" onClick={handleRetry}>
                <PaperAirplaneIcon className="w-4 h-4 mr-1" />
                Retry
              </Button>
            )}
            <Badge
              variant={
                send.status === 'sent' ? 'success' :
                send.status === 'failed' ? 'error' :
                send.status === 'sending' ? 'warning' :
                'neutral'
              }
            >
              {send.status}
            </Badge>
          </div>
        </div>

        {/* Error Message */}
        {send.error_message && (
          <Card className="p-4 mb-6 border-[var(--red-6)] bg-[var(--red-a2)]">
            <p className="text-sm text-[var(--red-11)]">{send.error_message}</p>
          </Card>
        )}

        {/* Delivery Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
          <Card className="p-4">
            <p className="text-xs text-[var(--gray-10)] uppercase">Recipients</p>
            <p className="text-xl font-semibold text-[var(--gray-12)]">{send.total_recipients}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-[var(--gray-10)] uppercase">Delivered</p>
            <p className="text-xl font-semibold text-[var(--green-9)]">{send.delivered_count}</p>
            <p className="text-xs text-[var(--gray-10)]">{deliveryRate}%</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-[var(--gray-10)] uppercase">Opens</p>
            <p className="text-xl font-semibold text-[var(--accent-9)]">{send.open_count}</p>
            <p className="text-xs text-[var(--gray-10)]">{openRate}%</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-[var(--gray-10)] uppercase">Clicks</p>
            <p className="text-xl font-semibold text-[var(--accent-9)]">{send.click_count}</p>
            <p className="text-xs text-[var(--gray-10)]">{clickRate}%</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-[var(--gray-10)] uppercase">Bounces</p>
            <p className="text-xl font-semibold text-[var(--red-9)]">{send.bounce_count}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-[var(--gray-10)] uppercase">Unsubscribes</p>
            <p className="text-xl font-semibold text-[var(--red-9)]">{send.unsubscribe_count}</p>
          </Card>
        </div>

        {/* Timeline */}
        <Card className="p-4">
          <h3 className="text-sm font-medium text-[var(--gray-12)] mb-2">Timeline</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-[var(--gray-10)]">Created</span>
              <span className="text-[var(--gray-12)]">{formatDate(send.created_at)}</span>
            </div>
            {send.scheduled_at && (
              <div className="flex justify-between">
                <span className="text-[var(--gray-10)]">Scheduled</span>
                <span className="text-[var(--gray-12)]">{formatDate(send.scheduled_at)}</span>
              </div>
            )}
            {send.sent_at && (
              <div className="flex justify-between">
                <span className="text-[var(--gray-10)]">Sent</span>
                <span className="text-[var(--gray-12)]">{formatDate(send.sent_at)}</span>
              </div>
            )}
          </div>
        </Card>
      </div>
    </Page>
  );
}
