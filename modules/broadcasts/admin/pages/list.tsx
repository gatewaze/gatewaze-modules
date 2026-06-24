import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { PlusIcon, PaperAirplaneIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { listBroadcasts, broadcastSummary, type Broadcast, type BroadcastStatus } from '../lib/broadcastService';

const STATUS_TONE: Record<BroadcastStatus, 'gray' | 'blue' | 'green' | 'amber' | 'red'> = {
  draft: 'gray', scheduled: 'blue', sending: 'amber', sent: 'green',
  cancelling: 'amber', cancelled: 'gray', failed: 'red', paused: 'amber',
};

export default function BroadcastListPage() {
  const navigate = useNavigate();
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setBroadcasts(await listBroadcasts());
    } catch (err) {
      console.error('Error loading broadcasts:', err);
      toast.error('Failed to load broadcasts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <Page title="Broadcasts">
      <WorkspaceLayout
        title="Broadcasts"
        actions={
          <Button variant="solid" onClick={() => navigate('/broadcasts/new')}>
            <PlusIcon className="h-4 w-4 mr-1" /> New Broadcast
          </Button>
        }
      >
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" />
          </div>
        ) : broadcasts.length === 0 ? (
          <div className="text-center py-16">
            <PaperAirplaneIcon className="h-16 w-16 text-[var(--gray-8)] mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-[var(--gray-12)] mb-2">No broadcasts yet</h2>
            <p className="text-[var(--gray-11)] mb-6 max-w-md mx-auto">
              Send a single email to a segment of your audience, scheduled and timezone-aware. Build
              the audience with plain language using the AI copilot.
            </p>
            <Button variant="solid" onClick={() => navigate('/broadcasts/new')}>
              <PlusIcon className="h-4 w-4 mr-1" /> Create Your First Broadcast
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {broadcasts.map((c) => {
              // The parent has no status/counts — derive a summary from its send
              // instances (latest active send, else most recent, else "draft").
              const { status, latest } = broadcastSummary(c);
              const sendCount = c.sends?.length ?? 0;
              return (
                <Card
                  key={c.id}
                  className="p-4 cursor-pointer hover:border-[var(--accent-7)] transition-colors"
                  onClick={() => navigate(`/broadcasts/${c.id}`)}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[var(--gray-12)] truncate">{c.name}</span>
                        <Badge color={STATUS_TONE[status]}>{status}</Badge>
                        {sendCount > 0 && <span className="text-xs text-[var(--gray-10)]">{sendCount} send{sendCount === 1 ? '' : 's'}</span>}
                      </div>
                      <div className="text-sm text-[var(--gray-11)] truncate">
                        {c.subject || <span className="italic">No subject yet</span>}
                      </div>
                    </div>
                    <div className="text-right text-sm text-[var(--gray-11)] shrink-0">
                      {latest && (latest.total_recipients ?? 0) > 0 && <div>{latest.total_recipients.toLocaleString()} recipients</div>}
                      {status === 'sent' && latest && <div>{latest.sent_count.toLocaleString()} sent · {latest.failed_count} failed</div>}
                      {latest?.scheduled_at && status === 'scheduled' && (
                        <div>scheduled {new Date(latest.scheduled_at).toLocaleString()}</div>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </WorkspaceLayout>
    </Page>
  );
}
