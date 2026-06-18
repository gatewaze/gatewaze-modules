import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { PlusIcon, PaperAirplaneIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { listCampaigns, type CampaignSend, type CampaignStatus } from '../lib/campaignService';

const STATUS_TONE: Record<CampaignStatus, 'gray' | 'blue' | 'green' | 'amber' | 'red'> = {
  draft: 'gray', scheduled: 'blue', sending: 'amber', sent: 'green',
  cancelling: 'amber', cancelled: 'gray', failed: 'red', paused: 'amber',
};

export default function CampaignListPage() {
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<CampaignSend[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setCampaigns(await listCampaigns());
    } catch (err) {
      console.error('Error loading campaigns:', err);
      toast.error('Failed to load campaigns');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <Page title="Campaigns">
      <WorkspaceLayout
        title="Campaigns"
        actions={
          <Button variant="solid" onClick={() => navigate('/campaigns/new')}>
            <PlusIcon className="h-4 w-4 mr-1" /> New Campaign
          </Button>
        }
      >
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" />
          </div>
        ) : campaigns.length === 0 ? (
          <div className="text-center py-16">
            <PaperAirplaneIcon className="h-16 w-16 text-[var(--gray-8)] mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-[var(--gray-12)] mb-2">No campaigns yet</h2>
            <p className="text-[var(--gray-11)] mb-6 max-w-md mx-auto">
              Send a single email to a segment of your audience, scheduled and timezone-aware. Build
              the audience with plain language using the AI copilot.
            </p>
            <Button variant="solid" onClick={() => navigate('/campaigns/new')}>
              <PlusIcon className="h-4 w-4 mr-1" /> Create Your First Campaign
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {campaigns.map((c) => (
              <Card
                key={c.id}
                className="p-4 cursor-pointer hover:border-[var(--accent-7)] transition-colors"
                onClick={() => navigate(`/campaigns/${c.id}`)}
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[var(--gray-12)] truncate">{c.name}</span>
                      <Badge color={STATUS_TONE[c.status]}>{c.status}</Badge>
                    </div>
                    <div className="text-sm text-[var(--gray-11)] truncate">
                      {c.subject || <span className="italic">No subject yet</span>}
                    </div>
                  </div>
                  <div className="text-right text-sm text-[var(--gray-11)] shrink-0">
                    <div>{c.total_recipients.toLocaleString()} recipients</div>
                    {c.status === 'sent' && <div>{c.sent_count.toLocaleString()} sent · {c.failed_count} failed</div>}
                    {c.scheduled_at && c.status === 'scheduled' && (
                      <div>scheduled {new Date(c.scheduled_at).toLocaleString()}</div>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </WorkspaceLayout>
    </Page>
  );
}
