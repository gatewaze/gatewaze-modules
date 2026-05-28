import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Card, Badge, Button, Select } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import {
  SpeakersRollupService,
  Talk,
  TalkScope,
  TalkStatus,
} from '../services/speakersRollupService';
import { useAuthContext } from '@/app/contexts/auth/context';

const SCOPE_OPTIONS: Array<{ value: TalkScope | 'all'; label: string }> = [
  { value: 'all', label: 'All scopes' },
  { value: 'calendar', label: 'Calendar-held' },
  { value: 'platform', label: 'Platform offers' },
  { value: 'event', label: 'Event-scheduled' },
];

const STATUS_OPTIONS: Array<{ value: TalkStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'held', label: 'Held' },
  { value: 'declined', label: 'Declined' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

export default function TalksIndexPage() {
  const navigate = useNavigate();
  const { user } = useAuthContext();
  const [talks, setTalks] = useState<Talk[]>([]);
  const [loading, setLoading] = useState(true);
  const [scopeFilter, setScopeFilter] = useState<TalkScope | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<TalkStatus | 'all'>('all');

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeFilter, statusFilter]);

  async function load() {
    setLoading(true);
    const result = await SpeakersRollupService.listCrossCalendarTalks({
      scope: scopeFilter,
      status: statusFilter === 'all' ? undefined : statusFilter,
      limit: 200,
    });
    if (result.success && result.data) setTalks(result.data);
    setLoading(false);
  }

  async function handleAccept(talkId: string) {
    const result = await SpeakersRollupService.updateTalkStatus(talkId, 'accepted', user?.id);
    if (result.success) {
      toast.success('Talk accepted');
      await load();
    } else {
      toast.error(result.error || 'Failed to accept');
    }
  }

  async function handleDecline(talkId: string) {
    const result = await SpeakersRollupService.updateTalkStatus(talkId, 'declined', user?.id);
    if (result.success) {
      toast.success('Talk declined');
      await load();
    } else {
      toast.error(result.error || 'Failed to decline');
    }
  }

  return (
    <Page title="Talks">
      <div className="space-y-4">
        <Card className="p-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <Select
              value={scopeFilter}
              onChange={(v: any) => setScopeFilter(v as any)}
              data={SCOPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
            <Select
              value={statusFilter}
              onChange={(v: any) => setStatusFilter(v as any)}
              data={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
          </div>
        </Card>

        <Card className="p-4">
          {loading ? (
            <div className="flex justify-center py-12"><LoadingSpinner /></div>
          ) : talks.length === 0 ? (
            <p className="text-sm text-[var(--gray-10)] text-center py-8">
              No talks match your filters.
            </p>
          ) : (
            <div className="space-y-2">
              {talks.map((talk) => (
                <div
                  key={talk.id}
                  className="border border-[var(--gray-6)] rounded px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge color="neutral" className="text-[10px]">{talk.scope}</Badge>
                        <Badge
                          color={
                            talk.status === 'accepted' ? 'success' :
                            talk.status === 'declined' ? 'error' :
                            talk.status === 'pending' ? 'warning' : 'neutral'
                          }
                          className="text-[10px]"
                        >
                          {talk.status}
                        </Badge>
                        <span className="text-[10px] text-[var(--gray-10)]">
                          {talk.duration_minutes}min
                        </span>
                      </div>
                      <h3 className="text-sm font-medium text-[var(--gray-12)] truncate">{talk.title}</h3>
                      {talk.synopsis && (
                        <p className="text-xs text-[var(--gray-10)] line-clamp-2 mt-1">{talk.synopsis}</p>
                      )}
                      <div className="text-xs text-[var(--gray-10)] mt-1">
                        by {talk.submitter_name || 'Unknown'}
                        {talk.submitter_email && ` · ${talk.submitter_email}`}
                        {' · '}
                        submitted {new Date(talk.submitted_at).toLocaleDateString()}
                      </div>
                      {talk.topics && talk.topics.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {talk.topics.map((t) => (
                            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--gray-3)] text-[var(--gray-11)]">
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    {talk.status === 'pending' && (
                      <div className="flex gap-2 flex-shrink-0">
                        <Button size="sm" variant="outline" onClick={() => handleDecline(talk.id)}>
                          Decline
                        </Button>
                        <Button size="sm" onClick={() => handleAccept(talk.id)}>
                          Accept
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
