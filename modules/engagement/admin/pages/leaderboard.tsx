import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { Card, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { EngagementService, LeaderboardEntry } from '../services/engagementService';

export default function LeaderboardPage() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const result = await EngagementService.getGlobalLeaderboard(100);
      if (result.success && result.data) setEntries(result.data);
      setLoading(false);
    })();
  }, []);

  return (
    <Page title="Leaderboard">
      {loading ? (
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      ) : (
        <Card className="p-4">
          {entries.length === 0 ? (
            <p className="text-sm text-[var(--gray-10)] text-center py-8">No engagement data yet.</p>
          ) : (
            <div className="space-y-1">
              {entries.map((e) => (
                <button
                  key={e.person_id}
                  onClick={() => navigate(`/engagement/members/${e.person_id}`)}
                  className="w-full text-left flex items-center justify-between border border-[var(--gray-6)] rounded px-4 py-3 hover:border-[var(--gray-8)]"
                >
                  <div className="flex items-center gap-3">
                    <Badge color={e.rank <= 3 ? 'warning' : 'neutral'} className="w-10 text-center">
                      #{e.rank}
                    </Badge>
                    <span className="font-mono text-sm text-[var(--gray-11)]">{e.display_name}…</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-[var(--gray-10)]">
                    <span>{e.event_count} events</span>
                    <span className="text-[var(--gray-12)] font-semibold text-sm">
                      {e.total_points.toLocaleString()} pts
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>
      )}
    </Page>
  );
}
