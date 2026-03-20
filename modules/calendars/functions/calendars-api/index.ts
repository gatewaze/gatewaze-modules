import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// XOR decoding function matching the Customer.io encoding
function decodeEmail(encodedEmail: string): string {
  if (!encodedEmail) return '';

  const passphrase = 'HideMe';

  try {
    // Handle URL-safe base64
    let base64String = encodedEmail
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    // Add padding if needed
    const paddingNeeded = base64String.length % 4;
    if (paddingNeeded > 0) {
      base64String += '='.repeat(4 - paddingNeeded);
    }

    // Base64 decode
    const decodedBytes = atob(base64String).split('').map(c => c.charCodeAt(0));

    // XOR decrypt
    let decodedString = '';
    for (let i = 0; i < decodedBytes.length; i++) {
      const passCharCode = passphrase.charCodeAt(i % passphrase.length);
      const decodedChar = String.fromCharCode(decodedBytes[i] ^ passCharCode);
      decodedString += decodedChar;
    }

    return decodedString.toLowerCase();
  } catch (error) {
    console.error('Email decoding failed:', error);
    return '';
  }
}

// Generate Google Calendar URL
function generateGoogleCalendarUrl(event: any): string {
  const startDate = new Date(event.event_start).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const endDate = new Date(event.event_end).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.event_title,
    dates: `${startDate}/${endDate}`,
    details: event.event_description || '',
    location: event.event_location || '',
    trp: 'false',
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// Generate Outlook Calendar URL
function generateOutlookCalendarUrl(event: any): string {
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: event.event_title,
    body: event.event_description || '',
    startdt: new Date(event.event_start).toISOString(),
    enddt: new Date(event.event_end).toISOString(),
    location: event.event_location || '',
    allday: 'false'
  });

  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

// Generate ICS file content
function generateICSFile(event: any, registration: any): string {
  const startDate = new Date(event.event_start);
  const endDate = new Date(event.event_end);

  // Format dates for ICS (YYYYMMDDTHHMMSSZ)
  const formatICSDate = (date: Date) => {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };

  // Build description
  const description = [
    event.event_description || '',
    '',
    '---',
    `Registration Type: ${registration.registration_type || 'Standard'}`,
    registration.badge_name ? `Badge Name: ${registration.badge_name}` : '',
    '',
    event.event_link ? `Event URL: ${event.event_link}` : '',
    '',
    'Powered by Gatewaze Events'
  ].filter(Boolean).join('\\n');

  // Build location
  const location = event.event_location || (event.event_link ? `Online: ${event.event_link}` : 'TBA');

  // Generate ICS content
  const icsContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gatewaze//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${event.event_id}@gatewaze.com`,
    `DTSTAMP:${formatICSDate(new Date())}`,
    `DTSTART:${formatICSDate(startDate)}`,
    `DTEND:${formatICSDate(endDate)}`,
    `SUMMARY:${event.event_title}`,
    `DESCRIPTION:${description}`,
    `LOCATION:${location}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'TRANSP:OPAQUE',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Event Reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  return icsContent;
}

export default async function(req: Request) {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const pathParts = url.pathname.split('/').filter(Boolean);

    // Expected format: /calendar/{event_id}/{calendar_type}/{email_encoded}
    // pathParts[0] = 'calendar'
    const eventId = pathParts[1];
    const calendarType = pathParts[2];
    const emailEncoded = pathParts[3];

    console.log('Request:', { eventId, calendarType, emailEncoded });

    if (!eventId || !calendarType || !emailEncoded) {
      return new Response(
        JSON.stringify({ error: 'Missing parameters. Expected format: /calendar/{event_id}/{type}/{email_encoded}' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase configuration');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Decode email
    const email = decodeEmail(emailEncoded);

    if (!email) {
      return new Response(
        JSON.stringify({ error: 'Invalid email encoding' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Decoded email:', email);

    // Check rate limiting
    const { data: rateLimitOk } = await supabase
      .rpc('check_calendar_rate_limit', {
        p_email_encoded: emailEncoded,
        p_event_id: eventId,
        p_max_requests: 1000
      });

    if (!rateLimitOk) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get registration and event data
    // First, find the person by email
    const { data: people, error: personError } = await supabase
      .from('people')
      .select('id')
      .eq('email', email)
      .limit(1);

    if (personError || !people || people.length === 0) {
      console.error('Person lookup error:', personError);
      return new Response(
        JSON.stringify({ error: 'No person found with this email' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const personId = people[0].id;

    // Then find the registration through member_profiles
    const { data: registrations, error: regError } = await supabase
      .from('events_registrations')
      .select(`
        *,
        events!inner (
          event_id,
          event_title,
          event_description,
          event_start,
          event_end,
          event_location,
          event_link
        ),
        people_profiles!inner (
          person_id
        )
      `)
      .eq('event_id', eventId)
      .eq('people_profiles.person_id', personId)
      .eq('status', 'confirmed');

    if (regError) {
      console.error('Registration query error:', regError);
      return new Response(
        JSON.stringify({ error: 'Database error', details: regError.message || regError }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let registration: any = null;
    let event: any = null;

    if (registrations && registrations.length > 0) {
      registration = registrations[0];
      event = registration.events;
    } else {
      // No registration found - check if they are a confirmed speaker
      // First get member profiles for this person
      const { data: memberProfiles } = await supabase
        .from('people_profiles')
        .select('id')
        .eq('person_id', personId);

      if (memberProfiles && memberProfiles.length > 0) {
        const profileIds = memberProfiles.map(p => p.id);

        // Check for confirmed speaker with a confirmed talk
        const { data: speakerData, error: speakerError } = await supabase
          .from('events_speakers')
          .select(`
            id,
            events!inner (
              event_id,
              event_title,
              event_description,
              event_start,
              event_end,
              event_location,
              event_link
            ),
            event_talk_speakers!inner (
              talk:event_talks!inner (
                status
              )
            )
          `)
          .eq('events.event_id', eventId)
          .in('people_profile_id', profileIds)
          .eq('event_talk_speakers.talk.status', 'confirmed')
          .limit(1);

        if (!speakerError && speakerData && speakerData.length > 0) {
          // Use speaker as the registration context (minimal registration data for ICS)
          registration = {
            registration_type: 'Speaker',
            badge_name: null,
          };
          event = speakerData[0].events;
        }
      }
    }

    if (!event) {
      return new Response(
        JSON.stringify({ error: 'No confirmed registration or speaker slot found for this email and event' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Track interaction (don't wait for it)
    // Extract first IP from x-forwarded-for (can contain comma-separated list)
    const forwardedFor = req.headers.get('x-forwarded-for');
    const ipAddress = forwardedFor
      ? forwardedFor.split(',')[0].trim()
      : req.headers.get('x-real-ip');

    supabase
      .from('calendars_interactions')
      .insert({
        email,
        email_encoded: emailEncoded,
        event_id: eventId,
        interaction_type: calendarType,
        ip_address: ipAddress || null,
        user_agent: req.headers.get('user-agent'),
        referer: req.headers.get('referer'),
        metadata: {
          timestamp: new Date().toISOString()
        }
      })
      .then(() => console.log('Interaction tracked'))
      .catch((err: any) => console.error('Failed to track interaction:', err));

    // Generate response based on calendar type
    switch (calendarType.toLowerCase()) {
      case 'google': {
        const googleUrl = generateGoogleCalendarUrl(event);
        return Response.redirect(googleUrl, 302);
      }

      case 'outlook': {
        const outlookUrl = generateOutlookCalendarUrl(event);
        return Response.redirect(outlookUrl, 302);
      }

      case 'apple':
      case 'ics':
      case 'download': {
        const icsContent = generateICSFile(event, registration);
        return new Response(icsContent, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/calendar; charset=utf-8',
            'Content-Disposition': `attachment; filename="${event.event_title.replace(/[^a-z0-9]/gi, '-')}.ics"`,
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          }
        });
      }

      case 'preview': {
        // Return a simple HTML preview page
        const html = `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${event.event_title} - Calendar</title>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                max-width: 600px;
                margin: 50px auto;
                padding: 20px;
                background: #f9fafb;
              }
              .card {
                background: white;
                border-radius: 12px;
                padding: 30px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
              }
              h1 { color: #111827; margin-bottom: 10px; }
              .meta { color: #6b7280; margin: 20px 0; }
              .buttons {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 10px;
                margin-top: 30px;
              }
              .btn {
                display: block;
                padding: 12px;
                text-align: center;
                text-decoration: none;
                border-radius: 8px;
                font-weight: 600;
                color: white;
                transition: opacity 0.2s;
              }
              .btn:hover { opacity: 0.9; }
              .google { background: #4285f4; }
              .outlook { background: #0078d4; }
              .apple { background: #000; }
              .ics { background: #6b7280; grid-column: span 2; }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>${event.event_title}</h1>
              <div class="meta">
                <div>📅 ${new Date(event.event_start).toLocaleDateString('en-US', {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric'
                })}</div>
                <div>⏰ ${new Date(event.event_start).toLocaleTimeString('en-US', {
                  hour: 'numeric',
                  minute: '2-digit',
                  timeZoneName: 'short'
                })}</div>
                ${event.event_location ? `<div>📍 ${event.event_location}</div>` : ''}
              </div>
              ${event.event_description ? `<p>${event.event_description}</p>` : ''}
              <div class="buttons">
                <a href="/calendar/${eventId}/google/${emailEncoded}" class="btn google">Google Calendar</a>
                <a href="/calendar/${eventId}/outlook/${emailEncoded}" class="btn outlook">Outlook</a>
                <a href="/calendar/${eventId}/apple/${emailEncoded}" class="btn apple">Apple Calendar</a>
                <a href="/calendar/${eventId}/ics/${emailEncoded}" class="btn ics">Download .ics File</a>
              </div>
            </div>
          </body>
          </html>
        `;

        return new Response(html, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/html; charset=utf-8'
          }
        });
      }

      default:
        return new Response(
          JSON.stringify({ error: `Invalid calendar type: ${calendarType}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }

  } catch (error) {
    console.error('Calendar handler error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
}