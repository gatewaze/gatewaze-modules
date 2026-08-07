// Add-to-calendar links for the confirmed-speaker checklist (and confirmed
// registrants): /calendar/{event_id}/{google|outlook|apple|ics}/{email_encoded}
//
// Ported from the legacy gatewaze-admin `calendar` function, which was never
// brought across — the portal checklist has been 404ing against it. Changes
// in the port:
//   - Deno.serve (the `serve` import/`export default` forms hang on this
//     platform's edge runtime);
//   - new schema: people/people_profiles/events_registrations and the
//     talk-centric speaker chain (events_speaker_profiles →
//     events_talk_speakers → events_talks.status='confirmed');
//   - ICS text fields are escaped per RFC 5545 (backslash, semicolon, comma,
//     newline; CR stripped) — event titles/descriptions are user-influenced
//     and must not inject ICS properties;
//   - the HTML preview mode is dropped (unescaped interpolation, no consumer);
//   - calendar_interactions/rate-limit RPC dropped (tables never ported); a
//     best-effort per-isolate limiter guards abuse instead. Completion
//     tracking happens separately via events-speaker-submissions.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// XOR + URL-safe-base64 email encoding shared with the portal (emailEncoding.ts).
function decodeEmail(encodedEmail: string): string {
  if (!encodedEmail || encodedEmail.length > 200) return '';
  const passphrase = 'HideMe';
  try {
    let base64String = encodedEmail.replace(/-/g, '+').replace(/_/g, '/');
    const paddingNeeded = base64String.length % 4;
    if (paddingNeeded > 0) base64String += '='.repeat(4 - paddingNeeded);
    const decodedBytes = atob(base64String).split('').map((c) => c.charCodeAt(0));
    let decoded = '';
    for (let i = 0; i < decodedBytes.length; i++) {
      decoded += String.fromCharCode(decodedBytes[i] ^ passphrase.charCodeAt(i % passphrase.length));
    }
    decoded = decoded.toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(decoded) ? decoded : '';
  } catch {
    return '';
  }
}

// Best-effort per-isolate rate limit (edge isolates are ephemeral; this
// shields bursts, not distributed abuse — the email must still match a
// confirmed registrant/speaker before anything is returned).
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimited(key: string, max = 60, windowMs = 60_000): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    if (rateBuckets.size > 5000) {
      for (const [k, b] of rateBuckets) if (b.resetAt <= now) rateBuckets.delete(k);
    }
    return false;
  }
  return ++bucket.count > max;
}

interface CalendarEvent {
  id: string;
  event_id: string;
  event_title: string;
  event_description: string | null;
  event_start: string;
  event_end: string;
  event_location: string | null;
  venue_address: string | null;
  event_link: string | null;
}

const formatCalDate = (iso: string) =>
  new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function locationOf(event: CalendarEvent): string {
  return event.venue_address || event.event_location || (event.event_link ? `Online: ${event.event_link}` : 'TBA');
}

function googleUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.event_title,
    dates: `${formatCalDate(event.event_start)}/${formatCalDate(event.event_end)}`,
    details: event.event_description || '',
    location: locationOf(event),
    trp: 'false',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function outlookUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: event.event_title,
    body: event.event_description || '',
    startdt: new Date(event.event_start).toISOString(),
    enddt: new Date(event.event_end).toISOString(),
    location: locationOf(event),
    allday: 'false',
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

/** RFC 5545 TEXT escaping — user-influenced values must not be able to
 *  inject ICS properties or fold lines. */
function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function icsFile(event: CalendarEvent, roleLine: string): string {
  const description = [
    event.event_description || '',
    '',
    '---',
    roleLine,
    '',
    event.event_link ? `Event URL: ${event.event_link}` : '',
    '',
    'Powered by Gatewaze Events',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gatewaze//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeIcs(event.event_id)}@gatewaze.com`,
    `DTSTAMP:${formatCalDate(new Date().toISOString())}`,
    `DTSTART:${formatCalDate(event.event_start)}`,
    `DTEND:${formatCalDate(event.event_end)}`,
    `SUMMARY:${escapeIcs(event.event_title)}`,
    `DESCRIPTION:${escapeIcs(description)}`,
    `LOCATION:${escapeIcs(locationOf(event))}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'TRANSP:OPAQUE',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Event Reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

const EVENT_COLUMNS =
  'id, event_id, event_title, event_description, event_start, event_end, event_location, venue_address, event_link';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const url = new URL(req.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    // Expected: /calendar/{event_id}/{type}/{email_encoded}
    const eventId = pathParts[1];
    const calendarType = (pathParts[2] ?? '').toLowerCase();
    const emailEncoded = pathParts[3];

    if (!eventId || !calendarType || !emailEncoded) {
      return json({ error: 'Expected format: /calendar/{event_id}/{type}/{email_encoded}' }, 400);
    }
    if (!/^[A-Za-z0-9-]{1,64}$/.test(eventId)) {
      return json({ error: 'Invalid event id' }, 400);
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (rateLimited(`cal:${ip}`)) {
      return json({ error: 'Rate limit exceeded. Please try again later.' }, 429);
    }

    const email = decodeEmail(emailEncoded);
    if (!email) return json({ error: 'Invalid email encoding' }, 400);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { data: event } = await supabase
      .from('events')
      .select(EVENT_COLUMNS)
      .eq('event_id', eventId)
      .maybeSingle<CalendarEvent>();
    if (!event) return json({ error: 'Event not found' }, 404);

    // Authorize: the email must belong to a confirmed speaker of this event,
    // or a confirmed registrant (person by email → registration).
    let roleLine: string | null = null;

    const { data: profiles } = await supabase
      .from('events_speaker_profiles')
      .select('id')
      .ilike('email', email);
    const profileIds = (profiles ?? []).map((p: { id: string }) => p.id);
    if (profileIds.length > 0) {
      const { data: bridges } = await supabase
        .from('events_talk_speakers')
        .select('talk:events_talks!inner(id, event_uuid, status)')
        .in('speaker_id', profileIds)
        .eq('talk.event_uuid', event.id)
        .eq('talk.status', 'confirmed')
        .limit(1);
      if ((bridges ?? []).length > 0) roleLine = 'Attending as: Speaker';
    }

    if (!roleLine) {
      const { data: person } = await supabase
        .from('people')
        .select('id')
        .ilike('email', email)
        .maybeSingle();
      if (person) {
        const { data: registration } = await supabase
          .from('events_registrations')
          .select('id, status')
          .eq('event_id', eventId)
          .eq('person_id', person.id)
          .in('status', ['confirmed', 'registered'])
          .limit(1)
          .maybeSingle();
        if (registration) roleLine = 'Registration Type: Standard';
      }
    }

    if (!roleLine) {
      return json({ error: 'No confirmed registration or speaker slot found for this email and event' }, 403);
    }

    switch (calendarType) {
      case 'google':
        return Response.redirect(googleUrl(event), 302);
      case 'outlook':
        return Response.redirect(outlookUrl(event), 302);
      case 'apple':
      case 'ics':
      case 'download': {
        const ics = icsFile(event, roleLine);
        return new Response(ics, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/calendar; charset=utf-8',
            'Content-Disposition': `attachment; filename="${event.event_title.replace(/[^a-z0-9]/gi, '-').slice(0, 80)}.ics"`,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          },
        });
      }
      default:
        return json({ error: `Invalid calendar type: ${calendarType}` }, 400);
    }
  } catch (error) {
    console.error('Calendar handler error:', error);
    return json({ error: 'Internal server error' }, 500);
  }
});
