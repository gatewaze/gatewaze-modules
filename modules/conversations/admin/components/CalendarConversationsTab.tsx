import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  ChatBubbleLeftRightIcon,
  PlusIcon,
  ArrowRightIcon,
} from '@heroicons/react/24/outline';
import { Card, Button, Badge } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import {
  ConversationsService,
  Conversation,
} from '../services/conversationsService';

interface Props {
  /** The calendar object from the calendars module's CalendarService */
  calendar: { id: string; name: string };
}

/**
 * Tab injected into the calendar admin detail page (via ModuleSlot) when
 * the conversations module is installed. Shows the calendar's default
 * channel + group channels, plus per-event channel quick-links.
 */
export function CalendarConversationsTab({ calendar }: Props) {
  const navigate = useNavigate();
  const [calendarConvs, setCalendarConvs] = useState<Conversation[]>([]);
  const [eventConvs, setEventConvs] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendar.id]);

  async function load() {
    setLoading(true);

    // Calendar-scoped channels
    const calResult = await ConversationsService.list({
      calendar_id: calendar.id,
      include_archived: false,
      limit: 50,
    });
    if (calResult.success && calResult.data) {
      setCalendarConvs(calResult.data.conversations);
    }

    // Event channels for events linked to this calendar.
    // Get event uuids first (via calendars_events junction).
    try {
      const { supabase } = await import('@/lib/supabase');
      const { data: linkRows } = await supabase
        .from('calendars_events')
        .select('event_id, events!inner(id, event_title)')
        .eq('calendar_id', calendar.id)
        .limit(500);

      const eventUuids = (linkRows || [])
        .map((row: any) => row.events?.id)
        .filter(Boolean);

      if (eventUuids.length > 0) {
        const { data: convs } = await supabase
          .from('admin_visible_conversations')
          .select('*')
          .eq('kind', 'event_channel')
          .in('event_id', eventUuids)
          .order('last_message_at', { ascending: false, nullsFirst: false });
        setEventConvs((convs || []) as Conversation[]);
      } else {
        setEventConvs([]);
      }
    } catch (err) {
      console.error('Failed to load event channels:', err);
    }

    setLoading(false);
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  const defaultChannel = calendarConvs.find((c) => c.is_default);
  const groupChannels = calendarConvs.filter((c) => c.kind === 'group_channel');

  return (
    <div className="space-y-6">
      {/* Default calendar channel */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--gray-12)]">Default channel</h2>
            <p className="text-sm text-[var(--gray-10)]">
              Every signed-in member of {calendar.name} can post here.
            </p>
          </div>
          {defaultChannel && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate(`/conversations/${defaultChannel.id}`)}
            >
              Moderate
              <ArrowRightIcon className="size-4 ml-1" />
            </Button>
          )}
        </div>
        {defaultChannel ? (
          <div className="flex items-center justify-between border border-[var(--gray-6)] rounded px-4 py-3">
            <div>
              <div className="flex items-center gap-2">
                <ChatBubbleLeftRightIcon className="size-4 text-[var(--gray-10)]" />
                <span className="text-sm font-medium text-[var(--gray-12)]">
                  {defaultChannel.title}
                </span>
                {defaultChannel.is_archived && (
                  <Badge color="warning" className="text-[10px]">archived</Badge>
                )}
              </div>
              <div className="text-xs text-[var(--gray-10)] mt-1">
                {defaultChannel.last_message_at
                  ? `Last message ${new Date(defaultChannel.last_message_at).toLocaleString()}`
                  : 'No messages yet'}
                {defaultChannel.slowmode_seconds > 0 && (
                  <> · slowmode {defaultChannel.slowmode_seconds}s</>
                )}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-[var(--gray-10)] italic">
            No default channel yet. The conversations module's seed migration creates one
            automatically when this calendar is enabled.
          </p>
        )}
      </Card>

      {/* Group channels */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-[var(--gray-12)]">Group channels</h2>
          <Button size="sm" variant="outline" disabled>
            <PlusIcon className="size-4 mr-1" />
            Create channel
          </Button>
        </div>
        {groupChannels.length === 0 ? (
          <p className="text-sm text-[var(--gray-10)]">
            No additional group channels for this calendar yet.
          </p>
        ) : (
          <div className="space-y-2">
            {groupChannels.map((conv) => (
              <button
                key={conv.id}
                onClick={() => navigate(`/conversations/${conv.id}`)}
                className="w-full text-left flex items-center justify-between border border-[var(--gray-6)] rounded px-4 py-3 hover:border-[var(--gray-8)]"
              >
                <span className="text-sm font-medium text-[var(--gray-12)]">{conv.title}</span>
                <ArrowRightIcon className="size-4 text-[var(--gray-10)]" />
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* Event channels (one per linked event) */}
      <Card className="p-6">
        <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-4">
          Event channels
          <span className="ml-2 text-sm font-normal text-[var(--gray-10)]">
            ({eventConvs.length})
          </span>
        </h2>
        {eventConvs.length === 0 ? (
          <p className="text-sm text-[var(--gray-10)]">
            No event channels yet. Each event linked to this calendar gets its own channel
            for registered attendees automatically.
          </p>
        ) : (
          <div className="space-y-2">
            {eventConvs.slice(0, 20).map((conv) => (
              <button
                key={conv.id}
                onClick={() => navigate(`/conversations/${conv.id}`)}
                className="w-full text-left flex items-center justify-between border border-[var(--gray-6)] rounded px-4 py-3 hover:border-[var(--gray-8)]"
              >
                <div>
                  <div className="text-sm font-medium text-[var(--gray-12)]">{conv.title}</div>
                  {conv.last_message_at && (
                    <div className="text-xs text-[var(--gray-10)] mt-0.5">
                      Last message {new Date(conv.last_message_at).toLocaleString()}
                    </div>
                  )}
                </div>
                <ArrowRightIcon className="size-4 text-[var(--gray-10)]" />
              </button>
            ))}
            {eventConvs.length > 20 && (
              <p className="text-xs text-[var(--gray-10)] text-center pt-2">
                Showing 20 of {eventConvs.length} event channels.
              </p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
