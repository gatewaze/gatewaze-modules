import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import { Card, Badge, Button } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { supabase } from '@/lib/supabase';

interface EventRow {
  id: string;
  signal: string;
  points: number;
  occurred_at: string;
  event_id: string | null;
  calendar_id: string | null;
}

interface CalendarScoreRow {
  calendar_id: string;
  total_points: number;
  event_count: number;
}

interface BadgeRow {
  id: string;
  badge_id: string;
  calendar_id: string | null;
  awarded_at: string;
  engagement_badges?: {
    slug: string;
    label: string;
    icon: string | null;
    color: string | null;
  };
}

export default function MemberDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [totalPoints, setTotalPoints] = useState(0);
  const [calendarScores, setCalendarScores] = useState<CalendarScoreRow[]>([]);
  const [badges, setBadges] = useState<BadgeRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);

  useEffect(() => {
    if (!id) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function load() {
    if (!id) return;
    setLoading(true);
    try {
      const [globalRes, calRes, badgesRes, eventsRes] = await Promise.all([
        supabase.from('engagement_scores_global').select('total_points').eq('person_id', id).maybeSingle(),
        supabase
          .from('engagement_scores_calendar')
          .select('calendar_id, total_points, event_count')
          .eq('person_id', id)
          .order('total_points', { ascending: false }),
        supabase
          .from('engagement_member_badges')
          .select('id, badge_id, calendar_id, awarded_at, engagement_badges(slug, label, icon, color)')
          .eq('person_id', id)
          .eq('is_revoked', false),
        supabase
          .from('engagement_events')
          .select('id, signal, points, occurred_at, event_id, calendar_id')
          .eq('person_id', id)
          .order('occurred_at', { ascending: false })
          .limit(50),
      ]);

      setTotalPoints((globalRes.data as any)?.total_points || 0);
      setCalendarScores((calRes.data || []) as CalendarScoreRow[]);
      setBadges((badgesRes.data || []) as BadgeRow[]);
      setEvents((eventsRes.data || []) as EventRow[]);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <Page title="Member">
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      </Page>
    );
  }

  return (
    <Page title={`Member ${id?.slice(0, 8)}`}>
      <div className="space-y-4">
        <button
          onClick={() => navigate(-1)}
          className="text-xs text-[var(--gray-10)] hover:text-[var(--gray-12)] flex items-center gap-1"
        >
          <ArrowLeftIcon className="size-3" />
          Back
        </button>

        {/* Header */}
        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-[var(--gray-12)] font-mono">{id}</h1>
              <p className="text-sm text-[var(--gray-10)] mt-1">{totalPoints.toLocaleString()} engagement points total</p>
            </div>
            <Button variant="outline" disabled>
              Award badge manually
            </Button>
          </div>
          {badges.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-4">
              {badges.map((b) => (
                <div
                  key={b.id}
                  className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[var(--gray-6)]"
                  style={{ background: (b.engagement_badges?.color || '#888') + '22' }}
                >
                  <span className="text-xs font-medium text-[var(--gray-12)]">
                    {b.engagement_badges?.label || b.badge_id.slice(0, 8)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Per-calendar breakdown */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-4">By calendar</h2>
          {calendarScores.length === 0 ? (
            <p className="text-sm text-[var(--gray-10)]">No calendar engagement yet.</p>
          ) : (
            <div className="space-y-1">
              {calendarScores.map((row) => (
                <div
                  key={row.calendar_id}
                  className="flex items-center justify-between px-3 py-2 border border-[var(--gray-6)] rounded"
                >
                  <span className="text-sm font-mono text-[var(--gray-11)]">{row.calendar_id.slice(0, 8)}…</span>
                  <div className="flex items-center gap-4 text-xs text-[var(--gray-10)]">
                    <span>{row.event_count} events</span>
                    <span className="text-[var(--gray-12)] font-semibold">{row.total_points.toLocaleString()} pts</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Event timeline */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-4">Recent activity</h2>
          {events.length === 0 ? (
            <p className="text-sm text-[var(--gray-10)]">No recorded activity.</p>
          ) : (
            <div className="space-y-1">
              {events.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center justify-between px-3 py-2 border border-[var(--gray-6)] rounded"
                >
                  <div className="flex items-center gap-2">
                    <Badge color="neutral" className="text-[10px] font-mono">{e.signal}</Badge>
                    <span className="text-xs text-[var(--gray-10)]">
                      {new Date(e.occurred_at).toLocaleString()}
                    </span>
                  </div>
                  <span className="text-xs font-semibold text-[var(--gray-12)]">
                    {e.points > 0 ? '+' : ''}{e.points} pts
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
