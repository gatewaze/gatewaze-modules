import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import {
  MicrophoneIcon,
  CheckIcon,
  XMarkIcon,
  ArrowsRightLeftIcon,
} from '@heroicons/react/24/outline';
import { Card, Badge, Button, Modal, Select } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { useAuthContext } from '@/app/contexts/auth/context';
import { supabase } from '@/lib/supabase';
import {
  SpeakersRollupService,
  CalendarTalkPoolRow,
  TalkStatus,
} from '../services/speakersRollupService';

interface Props {
  calendar: { id: string; name: string };
}

type TabKey = 'pool' | 'speakers';

const STATUS_TABS: Array<{ key: TalkStatus; label: string }> = [
  { key: 'pending', label: 'Pending' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'held', label: 'Held' },
  { key: 'declined', label: 'Declined' },
  { key: 'scheduled', label: 'Scheduled' },
];

interface EventOption {
  id: string;
  event_title: string;
  event_start: string | null;
}

export function CalendarSpeakersTab({ calendar }: Props) {
  const { user } = useAuthContext();
  const [activeTab, setActiveTab] = useState<TabKey>('pool');
  const [statusFilter, setStatusFilter] = useState<TalkStatus>('pending');
  const [rows, setRows] = useState<CalendarTalkPoolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [promoteTalkId, setPromoteTalkId] = useState<string | null>(null);
  const [eventOptions, setEventOptions] = useState<EventOption[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>('');

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendar.id, statusFilter]);

  async function load() {
    setLoading(true);
    const result = await SpeakersRollupService.getCalendarTalkPool(calendar.id, {
      status: statusFilter,
      limit: 200,
    });
    if (result.success && result.data) {
      setRows(result.data);
    } else {
      toast.error(result.error || 'Failed to load talk pool');
    }
    setLoading(false);
  }

  async function loadEventsForPromote() {
    // Upcoming events linked to this calendar
    const { data } = await supabase
      .from('calendars_events')
      .select('events!inner(id, event_title, event_start)')
      .eq('calendar_id', calendar.id);
    const now = new Date().toISOString();
    const options: EventOption[] = (data || [])
      .map((row: any) => row.events)
      .filter((ev: any) => ev && (!ev.event_start || ev.event_start >= now))
      .sort((a: any, b: any) => (a.event_start || '').localeCompare(b.event_start || ''));
    setEventOptions(options);
  }

  async function handleStatusChange(talkId: string, status: TalkStatus) {
    const result = await SpeakersRollupService.updateTalkStatus(talkId, status, user?.id);
    if (result.success) {
      toast.success(`Talk ${status}`);
      await load();
    } else {
      toast.error(result.error || 'Failed');
    }
  }

  async function handlePromote() {
    if (!promoteTalkId || !selectedEventId) return;
    const result = await SpeakersRollupService.promoteTalkToEvent(promoteTalkId, selectedEventId, true);
    if (result.success) {
      toast.success('Talk promoted to event');
      setPromoteTalkId(null);
      setSelectedEventId('');
      await load();
    } else {
      toast.error(result.error || 'Failed to promote');
    }
  }

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="flex gap-2 border-b border-[var(--gray-6)]">
        <button
          onClick={() => setActiveTab('pool')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'pool'
              ? 'border-[var(--accent-9)] text-[var(--gray-12)]'
              : 'border-transparent text-[var(--gray-10)] hover:text-[var(--gray-12)]'
          }`}
        >
          Talk pool
        </button>
        <button
          onClick={() => setActiveTab('speakers')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'speakers'
              ? 'border-[var(--accent-9)] text-[var(--gray-12)]'
              : 'border-transparent text-[var(--gray-10)] hover:text-[var(--gray-12)]'
          }`}
        >
          Speakers
        </button>
      </div>

      {activeTab === 'pool' && (
        <>
          {/* Status filter tabs */}
          <div className="flex flex-wrap gap-2">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setStatusFilter(tab.key)}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  statusFilter === tab.key
                    ? 'bg-[var(--accent-9)] text-white border-[var(--accent-9)]'
                    : 'bg-[var(--gray-2)] text-[var(--gray-11)] border-[var(--gray-6)] hover:border-[var(--gray-8)]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <Card className="p-4">
            {loading ? (
              <div className="flex justify-center py-12"><LoadingSpinner /></div>
            ) : rows.length === 0 ? (
              <p className="text-sm text-[var(--gray-10)] text-center py-8">
                No {statusFilter} talks for this calendar.
              </p>
            ) : (
              <div className="space-y-2">
                {rows.map((row) => (
                  <div key={row.id} className="border border-[var(--gray-6)] rounded px-4 py-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-medium text-[var(--gray-12)]">{row.title}</h3>
                        {row.synopsis && (
                          <p className="text-xs text-[var(--gray-10)] line-clamp-2 mt-1">{row.synopsis}</p>
                        )}
                        <div className="text-xs text-[var(--gray-10)] mt-1">
                          by {row.speaker_name || 'Unknown'}
                          {row.speaker_company && ` · ${row.speaker_company}`}
                          {' · '}
                          {row.duration_minutes}min
                        </div>
                      </div>
                      {statusFilter === 'pending' && (
                        <div className="flex gap-1 flex-shrink-0">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleStatusChange(row.id, 'declined')}
                            title="Decline"
                          >
                            <XMarkIcon className="size-4" />
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => handleStatusChange(row.id, 'accepted')}
                            title="Accept"
                          >
                            <CheckIcon className="size-4" />
                          </Button>
                        </div>
                      )}
                      {statusFilter === 'accepted' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setPromoteTalkId(row.id);
                            loadEventsForPromote();
                          }}
                        >
                          <ArrowsRightLeftIcon className="size-4 mr-1" />
                          Promote
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {activeTab === 'speakers' && (
        <Card className="p-4">
          <p className="text-sm text-[var(--gray-10)] text-center py-8">
            Speakers list coming soon — use the cross-calendar directory at /speakers for now.
          </p>
        </Card>
      )}

      {/* Promote-to-event modal */}
      <Modal
        isOpen={!!promoteTalkId}
        onClose={() => {
          setPromoteTalkId(null);
          setSelectedEventId('');
        }}
        title="Promote talk to event"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--gray-10)]">
            Select an upcoming event from {calendar.name} to attach this talk to.
          </p>
          {eventOptions.length === 0 ? (
            <p className="text-xs text-[var(--gray-10)] italic">
              No upcoming events in this calendar.
            </p>
          ) : (
            <Select
              value={selectedEventId}
              onChange={(v: any) => setSelectedEventId(v)}
              data={eventOptions.map((e) => ({
                value: e.id,
                label: `${e.event_title}${e.event_start ? ' — ' + new Date(e.event_start).toLocaleDateString() : ''}`,
              }))}
              placeholder="Select an event"
            />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPromoteTalkId(null)}>
              Cancel
            </Button>
            <Button onClick={handlePromote} disabled={!selectedEventId}>
              Promote
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
