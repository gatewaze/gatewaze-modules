import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { PlusIcon, PaperAirplaneIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Button, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { listBroadcasts, type Broadcast } from '../lib/broadcastService';
import { BroadcastsTable } from '../components/BroadcastsTable';

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
          <BroadcastsTable broadcasts={broadcasts} />
        )}
      </WorkspaceLayout>
    </Page>
  );
}
