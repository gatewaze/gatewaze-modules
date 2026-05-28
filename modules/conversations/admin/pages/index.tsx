import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  ChatBubbleLeftRightIcon,
  UsersIcon,
  EnvelopeIcon,
} from '@heroicons/react/24/outline';
import { Card, Button, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { ConversationsService, Conversation } from '../services/conversationsService';

interface OverviewStats {
  total: number;
  channels: number;
  dms: number;
  archivedCount: number;
  recentActivity: Conversation[];
}

export default function ConversationsIndexPage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, []);

  async function loadStats() {
    setLoading(true);
    try {
      const result = await ConversationsService.list({ limit: 100, include_archived: true });
      if (result.success && result.data) {
        const all = result.data.conversations;
        const stats: OverviewStats = {
          total: result.data.total,
          channels: all.filter((c) => c.kind !== 'dm').length,
          dms: all.filter((c) => c.kind === 'dm').length,
          archivedCount: all.filter((c) => c.is_archived).length,
          recentActivity: all
            .filter((c) => c.last_message_at)
            .slice(0, 10),
        };
        setStats(stats);
      }
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <Page title="Conversations">
        <div className="flex justify-center py-12"><LoadingSpinner size="large" /></div>
      </Page>
    );
  }

  return (
    <Page title="Conversations">
      <div className="space-y-6">
        {/* Stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-bold text-[var(--gray-12)]">{stats?.total ?? 0}</div>
                <div className="text-sm text-[var(--gray-10)]">Total visible</div>
              </div>
              <ChatBubbleLeftRightIcon className="size-8 text-[var(--gray-9)]" />
            </div>
          </Card>
          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-bold text-[var(--gray-12)]">{stats?.channels ?? 0}</div>
                <div className="text-sm text-[var(--gray-10)]">Channels</div>
              </div>
              <UsersIcon className="size-8 text-[var(--gray-9)]" />
            </div>
          </Card>
          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-bold text-[var(--gray-12)]">{stats?.dms ?? 0}</div>
                <div className="text-sm text-[var(--gray-10)]">DMs (audited only)</div>
              </div>
              <EnvelopeIcon className="size-8 text-[var(--gray-9)]" />
            </div>
          </Card>
          <Card className="p-6">
            <div>
              <div className="text-2xl font-bold text-[var(--gray-12)]">{stats?.archivedCount ?? 0}</div>
              <div className="text-sm text-[var(--gray-10)]">Archived</div>
            </div>
          </Card>
        </div>

        {/* CTAs */}
        <div className="flex gap-2">
          <Button onClick={() => navigate('/conversations/all')}>Browse conversations</Button>
          <Button variant="outline" onClick={() => navigate('/conversations/usernames')}>
            Manage usernames
          </Button>
          <Button variant="outline" onClick={() => navigate('/conversations/settings')}>
            Settings
          </Button>
        </div>

        {/* Recent activity */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-4">Recent activity</h2>
          {!stats || stats.recentActivity.length === 0 ? (
            <p className="text-sm text-[var(--gray-10)]">No recent activity.</p>
          ) : (
            <div className="space-y-2">
              {stats.recentActivity.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => navigate(`/conversations/${conv.id}`)}
                  className="w-full text-left flex items-center justify-between border border-[var(--gray-6)] rounded-md px-4 py-3 hover:border-[var(--gray-8)] transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge color="neutral" className="text-[10px]">{conv.kind.replace('_', ' ')}</Badge>
                      {conv.is_archived && <Badge color="warning" className="text-[10px]">archived</Badge>}
                    </div>
                    <div className="text-sm font-medium text-[var(--gray-12)] mt-1 truncate">
                      {conv.title || <span className="italic text-[var(--gray-10)]">untitled</span>}
                    </div>
                  </div>
                  <div className="text-xs text-[var(--gray-10)] flex-shrink-0">
                    {conv.last_message_at
                      ? new Date(conv.last_message_at).toLocaleString()
                      : 'no messages'}
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
