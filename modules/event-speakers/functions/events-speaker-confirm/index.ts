import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Generate HTML response page
function generateHtmlPage(
  success: boolean,
  title: string,
  message: string,
  eventTitle?: string
): string {
  const iconSvg = success
    ? `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="icon success">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="icon error">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
      </svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #f5f7fa 0%, #e4e8ec 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      padding: 48px;
      max-width: 480px;
      width: 100%;
      text-align: center;
    }
    .icon {
      width: 72px;
      height: 72px;
      margin-bottom: 24px;
    }
    .icon.success {
      color: #10b981;
    }
    .icon.error {
      color: #ef4444;
    }
    h1 {
      font-size: 24px;
      font-weight: 600;
      color: #1f2937;
      margin-bottom: 12px;
    }
    .message {
      font-size: 16px;
      color: #6b7280;
      line-height: 1.6;
      margin-bottom: 8px;
    }
    .event-name {
      font-size: 18px;
      font-weight: 500;
      color: #374151;
      margin-top: 16px;
      padding: 12px 16px;
      background: #f9fafb;
      border-radius: 8px;
    }
    .footer {
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid #e5e7eb;
      font-size: 14px;
      color: #9ca3af;
    }
  </style>
</head>
<body>
  <div class="container">
    ${iconSvg}
    <h1>${title}</h1>
    <p class="message">${message}</p>
    ${eventTitle ? `<div class="event-name">${eventTitle}</div>` : ''}
    <div class="footer">You can close this page now.</div>
  </div>
</body>
</html>`;
}

// Return HTML response
function htmlResponse(html: string, status: number = 200): Response {
  return new Response(html, {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}

export default async function(req: Request) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Get parameters from query string
    const url = new URL(req.url);
    const token = url.searchParams.get('token');
    const targetEventId = url.searchParams.get('event_id'); // Optional: 6-character event ID for cross-event confirmation

    if (!token) {
      return htmlResponse(
        generateHtmlPage(false, 'Invalid Link', 'The confirmation link is missing required information.'),
        400
      );
    }

    // Create Supabase client with service role
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Find the talk with this confirmation token
    // Confirmation tokens are now on the event_talks table
    const { data: talk, error: findError } = await supabaseClient
      .from('events_talks')
      .select(`
        id,
        event_uuid,
        title,
        synopsis,
        duration_minutes,
        status,
        confirmation_token,
        confirmed_at,
        is_featured
      `)
      .eq('confirmation_token', token)
      .single();

    if (findError || !talk) {
      console.error('Talk not found:', findError);
      return htmlResponse(
        generateHtmlPage(false, 'Invalid Link', 'This confirmation link is invalid or has expired. Please contact the event organizers if you need assistance.'),
        404
      );
    }

    // Get the primary speaker for this talk
    const { data: talkSpeaker, error: speakerError } = await supabaseClient
      .from('events_talk_speakers')
      .select(`
        speaker_id,
        speaker:event_speakers (
          id,
          people_profile_id,
          speaker_title,
          speaker_bio,
          speaker_topic,
          event_sponsor_id
        )
      `)
      .eq('talk_id', talk.id)
      .eq('is_primary', true)
      .single();

    if (speakerError || !talkSpeaker?.speaker) {
      console.error('Primary speaker not found for talk:', speakerError);
      return htmlResponse(
        generateHtmlPage(false, 'Invalid Link', 'Could not find speaker information for this confirmation. Please contact the event organizers.'),
        404
      );
    }

    const speaker = talkSpeaker.speaker as any;

    // If event_id is provided, this is a cross-event confirmation
    // (e.g., rejected speaker being offered a slot at a different event)
    if (targetEventId) {
      // Look up the target event by its 6-character event_id
      const { data: targetEvent, error: eventError } = await supabaseClient
        .from('events')
        .select('id, event_title, event_id')
        .eq('event_id', targetEventId)
        .single();

      if (eventError || !targetEvent) {
        console.error('Target event not found:', eventError);
        return htmlResponse(
          generateHtmlPage(false, 'Event Not Found', 'The event associated with this confirmation link could not be found.'),
          404
        );
      }

      const targetEventUuid = targetEvent.id;

      // Check if speaker is already registered for the target event
      const { data: existingSpeaker } = await supabaseClient
        .from('events_speakers')
        .select('id')
        .eq('event_uuid', targetEventUuid)
        .eq('people_profile_id', speaker.people_profile_id)
        .maybeSingle();

      if (existingSpeaker) {
        // Check if they have a talk for this event
        const { data: existingTalk } = await supabaseClient
          .from('events_talk_speakers')
          .select('talk:event_talks(id, status)')
          .eq('speaker_id', existingSpeaker.id)
          .eq('is_primary', true)
          .maybeSingle();

        if (existingTalk?.talk) {
          const existingTalkData = existingTalk.talk as any;
          if (existingTalkData.status === 'confirmed') {
            return htmlResponse(
              generateHtmlPage(true, 'Already Confirmed', 'You are already confirmed as a speaker for this event!', targetEvent.event_title)
            );
          }

          // Update existing talk to confirmed
          const { error: updateError } = await supabaseClient
            .from('events_talks')
            .update({
              status: 'confirmed',
              confirmed_at: new Date().toISOString(),
            })
            .eq('id', existingTalkData.id);

          if (updateError) {
            console.error('Error updating existing talk:', updateError);
            return htmlResponse(
              generateHtmlPage(false, 'Confirmation Failed', 'We were unable to confirm your speaker slot. Please try again or contact the event organizers.'),
              500
            );
          }

          console.log(`Talk ${existingTalkData.id} confirmed for different event ${targetEvent.event_title}`);

          return htmlResponse(
            generateHtmlPage(true, 'Speaker Confirmed!', 'Your speaker slot has been confirmed. We look forward to seeing you at the event!', targetEvent.event_title)
          );
        }
      }

      // Create new speaker entry for the target event
      const { data: newSpeaker, error: createSpeakerError } = await supabaseClient
        .from('events_speakers')
        .insert({
          event_uuid: targetEventUuid,
          people_profile_id: speaker.people_profile_id,
          speaker_title: speaker.speaker_title,
          speaker_bio: speaker.speaker_bio,
          speaker_topic: speaker.speaker_topic,
          is_featured: false,
        })
        .select('id')
        .single();

      if (createSpeakerError) {
        console.error('Error creating speaker for target event:', createSpeakerError);
        return htmlResponse(
          generateHtmlPage(false, 'Confirmation Failed', 'We were unable to confirm your speaker slot. Please try again or contact the event organizers.'),
          500
        );
      }

      // Create new talk for the target event
      const { data: newTalk, error: createTalkError } = await supabaseClient
        .from('events_talks')
        .insert({
          event_uuid: targetEventUuid,
          title: talk.title,
          synopsis: talk.synopsis,
          duration_minutes: talk.duration_minutes,
          session_type: 'talk',
          status: 'confirmed',
          confirmed_at: new Date().toISOString(),
          is_featured: false,
        })
        .select('id')
        .single();

      if (createTalkError) {
        console.error('Error creating talk for target event:', createTalkError);
        // Clean up the speaker we just created
        await supabaseClient.from('events_speakers').delete().eq('id', newSpeaker.id);
        return htmlResponse(
          generateHtmlPage(false, 'Confirmation Failed', 'We were unable to confirm your speaker slot. Please try again or contact the event organizers.'),
          500
        );
      }

      // Link the new speaker to the new talk
      const { error: linkError } = await supabaseClient
        .from('events_talk_speakers')
        .insert({
          talk_id: newTalk.id,
          speaker_id: newSpeaker.id,
          role: 'presenter',
          is_primary: true,
          sort_order: 0,
        });

      if (linkError) {
        console.error('Error linking speaker to talk:', linkError);
        // Non-fatal, log but continue
      }

      console.log(`Speaker ${speaker.people_profile_id} created and confirmed for different event ${targetEvent.event_title} (new speaker ID: ${newSpeaker.id}, new talk ID: ${newTalk.id})`);

      return htmlResponse(
        generateHtmlPage(true, 'Speaker Confirmed!', 'Your speaker slot has been confirmed. We look forward to seeing you at the event!', targetEvent.event_title)
      );
    }

    // Standard confirmation for the same event
    // Check if already confirmed
    if (talk.status === 'confirmed') {
      // Get event details for the response
      const { data: event } = await supabaseClient
        .from('events')
        .select('event_title, event_id')
        .eq('id', talk.event_uuid)
        .single();

      return htmlResponse(
        generateHtmlPage(true, 'Already Confirmed', 'Your speaker slot has already been confirmed.', event?.event_title)
      );
    }

    // Only allow confirmation if status is 'approved'
    if (talk.status !== 'approved') {
      console.log(`Talk ${talk.id} has status ${talk.status}, cannot confirm`);

      let message = 'Your speaker application is not in a state that can be confirmed.';
      if (talk.status === 'pending') {
        message = 'Your speaker application is still pending review. Please wait for approval before confirming.';
      } else if (talk.status === 'rejected') {
        message = 'Unfortunately, your speaker application was not accepted for this event.';
      } else if (talk.status === 'reserve') {
        message = 'You are currently on the reserve list. You will be notified if a slot becomes available.';
      }

      return htmlResponse(
        generateHtmlPage(false, 'Cannot Confirm', message),
        400
      );
    }

    // Update talk status to confirmed
    const { error: updateError } = await supabaseClient
      .from('events_talks')
      .update({
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', talk.id);

    if (updateError) {
      console.error('Error updating talk:', updateError);
      return htmlResponse(
        generateHtmlPage(false, 'Confirmation Failed', 'We were unable to confirm your speaker slot. Please try again or contact the event organizers.'),
        500
      );
    }

    // Get event details for the response
    const { data: event } = await supabaseClient
      .from('events')
      .select('event_title, event_id')
      .eq('id', talk.event_uuid)
      .single();

    console.log(`Talk ${talk.id} confirmed for event ${event?.event_title || talk.event_uuid}`);

    return htmlResponse(
      generateHtmlPage(true, 'Speaker Confirmed!', 'Your speaker slot has been confirmed. We look forward to seeing you at the event!', event?.event_title)
    );
  } catch (error: any) {
    console.error('Error in speaker-confirm function:', error);
    return htmlResponse(
      generateHtmlPage(false, 'Something Went Wrong', 'An unexpected error occurred. Please try again or contact the event organizers.'),
      500
    );
  }
}
