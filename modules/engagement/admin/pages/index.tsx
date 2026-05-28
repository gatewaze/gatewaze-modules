import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { TrophyIcon, UsersIcon, SparklesIcon, ChartBarIcon } from '@heroicons/react/24/outline';
import { Card, Button } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { EngagementService, EngagementOverview } from '../services/engagementService';

export default function EngagementIndexPage() {
  const navigate = useNavigate();
  const [overview, setOverview] = useState<EngagementOverview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const result = await EngagementService.getOverview();
      if (result.success && result.data) setOverview(result.data);
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return (
      <Page title="Engagement">
        <div className="flex justify-center py-12"><LoadingSpinner size="large" /></div>
      </Page>
    );
  }

  return (
    <Page title="Engagement">
      <div className="space-y-6">
        {/* Stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-bold text-[var(--gray-12)]">
                  {overview?.totalMembersTracked.toLocaleString() ?? 0}
                </div>
                <div className="text-sm text-[var(--gray-10)]">Members tracked</div>
              </div>
              <UsersIcon className="size-8 text-[var(--gray-9)]" />
            </div>
          </Card>
          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-bold text-[var(--gray-12)]">
                  {overview?.totalEventsThisWeek.toLocaleString() ?? 0}
                </div>
                <div className="text-sm text-[var(--gray-10)]">Events this week</div>
              </div>
              <ChartBarIcon className="size-8 text-[var(--gray-9)]" />
            </div>
          </Card>
          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-bold text-[var(--gray-12)]">
                  {overview?.totalEventsThisMonth.toLocaleString() ?? 0}
                </div>
                <div className="text-sm text-[var(--gray-10)]">Events this month</div>
              </div>
              <ChartBarIcon className="size-8 text-[var(--gray-9)]" />
            </div>
          </Card>
          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-bold text-[var(--gray-12)]">
                  {overview?.badgesAwardedThisMonth.toLocaleString() ?? 0}
                </div>
                <div className="text-sm text-[var(--gray-10)]">Badges awarded this month</div>
              </div>
              <SparklesIcon className="size-8 text-[var(--gray-9)]" />
            </div>
          </Card>
        </div>

        {/* CTAs */}
        <div className="flex gap-2">
          <Button onClick={() => navigate('/engagement/leaderboard')}>
            <TrophyIcon className="size-4 mr-1" />
            View leaderboard
          </Button>
          <Button variant="outline" onClick={() => navigate('/engagement/badges')}>
            Badges
          </Button>
          <Button variant="outline" onClick={() => navigate('/engagement/rules')}>
            Scoring rules
          </Button>
        </div>

        {/* Top members preview */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-4">Top members (platform-wide)</h2>
          {!overview?.topMembers.length ? (
            <p className="text-sm text-[var(--gray-10)]">No engagement data yet.</p>
          ) : (
            <div className="space-y-2">
              {overview.topMembers.map((m, idx) => (
                <button
                  key={m.person_id}
                  onClick={() => navigate(`/engagement/members/${m.person_id}`)}
                  className="w-full text-left flex items-center justify-between border border-[var(--gray-6)] rounded px-4 py-3 hover:border-[var(--gray-8)]"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-[var(--gray-11)] w-6">#{idx + 1}</span>
                    <span className="text-sm font-mono text-[var(--gray-11)]">{m.person_id.slice(0, 8)}…</span>
                  </div>
                  <div className="text-sm font-semibold text-[var(--gray-12)]">
                    {m.total_points.toLocaleString()} pts
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
