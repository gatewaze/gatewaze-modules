import { useState, useEffect, useCallback } from 'react';
import {
  CalendarIcon,
  CheckCircleIcon,
} from '@heroicons/react/24/outline';
import { Square3Stack3DIcon } from '@heroicons/react/24/outline';
import { Card, Badge } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import type { Person } from '@/utils/peopleService';

interface EventDetails {
  event_title: string;
  event_city?: string;
  event_country_code?: string;
  event_start?: string;
}

interface EventRegistration {
  id: string;
  event_id: string;
  status: string;
  registered_at: string;
  event?: EventDetails;
}

interface EventAttendance {
  id: string;
  event_id: string;
  checked_in_at: string;
  event?: EventDetails;
}

interface SpeakerSubmission {
  id: string;
  event_uuid: string;
  status: string;
  talk_title?: string;
  submitted_at: string;
  event?: EventDetails;
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  const intervals: [string, number][] = [
    ['year', 31536000], ['month', 2592000], ['week', 604800],
    ['day', 86400], ['hour', 3600], ['minute', 60],
  ];
  for (const [unit, secs] of intervals) {
    const interval = Math.floor(seconds / secs);
    if (interval >= 1) return `${interval} ${unit}${interval === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

interface PersonEventsTabProps {
  person: Person;
  personId: string;
}

export default function PersonEventsTab({ person, personId }: PersonEventsTabProps) {
  const [registrations, setRegistrations] = useState<EventRegistration[]>([]);
  const [attendances, setAttendances] = useState<EventAttendance[]>([]);
  const [speakers, setSpeakers] = useState<SpeakerSubmission[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!personId) return;
    try {
      const { data: profileData } = await supabase
        .from('people_profiles')
        .select('id')
        .eq('person_id', personId);

      const profileIds = (profileData || []).map((p: any) => p.id);
      if (profileIds.length === 0) { setLoading(false); return; }

      const [regResult, attendResult, speakerResult] = await Promise.all([
        supabase.from('events_registrations')
          .select('id, event_id, status, registered_at, ticket_type, registration_type')
          .in('people_profile_id', profileIds)
          .order('registered_at', { ascending: false }),
        supabase.from('events_attendance')
          .select('id, event_id, checked_in_at, checked_out_at')
          .in('people_profile_id', profileIds)
          .order('checked_in_at', { ascending: false }),
        supabase.from('events_speakers')
          .select('id, event_uuid, status, talk_title, submitted_at')
          .in('people_profile_id', profileIds)
          .order('submitted_at', { ascending: false }),
      ]);

      const regData = regResult.data || [];
      const attendData = attendResult.data || [];
      const speakerData = speakerResult.data || [];

      // Fetch event details
      const allEventIds = [...new Set([
        ...regData.map((r: any) => r.event_id),
        ...attendData.map((a: any) => a.event_id),
        ...speakerData.map((s: any) => s.event_uuid?.toString()),
      ].filter(Boolean))];

      const eventsMap = new Map<string, EventDetails>();
      if (allEventIds.length > 0) {
        const { data: eventDetails } = await supabase
          .from('events')
          .select('id, event_title, event_city, event_country_code, event_start')
          .in('id', allEventIds);
        for (const e of eventDetails || []) {
          eventsMap.set(e.id, e);
        }
      }

      setRegistrations(regData.map((r: any) => ({ ...r, event: eventsMap.get(r.event_id) })));
      setAttendances(attendData.map((a: any) => ({ ...a, event: eventsMap.get(a.event_id) })));
      setSpeakers(speakerData.map((s: any) => ({ ...s, event: eventsMap.get(s.event_uuid?.toString()) })));
    } catch (err) {
      console.error('Error loading person events:', err);
    } finally {
      setLoading(false);
    }
  }, [personId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Registrations */}
      <Card variant="surface" className="p-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <CalendarIcon className="size-5" />
          Registered ({registrations.length})
        </h2>
        {registrations.length === 0 ? (
          <p className="text-sm text-[var(--gray-11)]">No event registrations found.</p>
        ) : (
          <div className="space-y-2">
            {registrations.map((reg) => (
              <div key={reg.id} className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-[var(--gray-12)] truncate">
                      {reg.event?.event_title || reg.event_id}
                    </p>
                    {(reg.event?.event_city || reg.event?.event_country_code) && (
                      <p className="text-sm text-[var(--gray-11)] mt-0.5">
                        {[reg.event.event_city, reg.event.event_country_code].filter(Boolean).join(', ')}
                      </p>
                    )}
                    {reg.event?.event_start && (
                      <p className="text-xs text-[var(--gray-a8)] mt-0.5">
                        {new Date(reg.event.event_start).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <Badge variant="soft" color={reg.status === 'confirmed' ? 'green' : reg.status === 'cancelled' ? 'red' : 'orange'}>
                      {reg.status}
                    </Badge>
                    {reg.registered_at && (
                      <span className="text-xs text-[var(--gray-a8)]">{formatTimeAgo(reg.registered_at)}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Attended */}
      <Card variant="surface" className="p-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <CheckCircleIcon className="size-5" />
          Attended ({attendances.length})
        </h2>
        {attendances.length === 0 ? (
          <p className="text-sm text-[var(--gray-11)]">No event attendance records found.</p>
        ) : (
          <div className="space-y-2">
            {attendances.map((att) => (
              <div key={att.id} className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-[var(--gray-12)] truncate">
                      {att.event?.event_title || att.event_id}
                    </p>
                    {(att.event?.event_city || att.event?.event_country_code) && (
                      <p className="text-sm text-[var(--gray-11)] mt-0.5">
                        {[att.event.event_city, att.event.event_country_code].filter(Boolean).join(', ')}
                      </p>
                    )}
                  </div>
                  {att.checked_in_at && (
                    <span className="text-xs text-[var(--gray-a8)] shrink-0">
                      Checked in {formatTimeAgo(att.checked_in_at)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Speaker submissions */}
      <Card variant="surface" className="p-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Square3Stack3DIcon className="size-5" />
          Speaker Submissions ({speakers.length})
        </h2>
        {speakers.length === 0 ? (
          <p className="text-sm text-[var(--gray-11)]">No speaker submissions found.</p>
        ) : (
          <div className="space-y-2">
            {speakers.map((sub) => (
              <div key={sub.id} className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-[var(--gray-12)] truncate">
                      {sub.event?.event_title || sub.event_uuid}
                    </p>
                    {sub.talk_title && (
                      <p className="text-sm text-[var(--gray-11)] mt-0.5 italic truncate">
                        "{sub.talk_title}"
                      </p>
                    )}
                    {(sub.event?.event_city || sub.event?.event_country_code) && (
                      <p className="text-sm text-[var(--gray-11)] mt-0.5">
                        {[sub.event.event_city, sub.event.event_country_code].filter(Boolean).join(', ')}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <Badge variant="soft" color={sub.status === 'approved' || sub.status === 'confirmed' ? 'green' : sub.status === 'rejected' ? 'red' : 'orange'}>
                      {sub.status}
                    </Badge>
                    {sub.submitted_at && (
                      <span className="text-xs text-[var(--gray-a8)]">{formatTimeAgo(sub.submitted_at)}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
