
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Slack Notification Edge Function
 *
 * Sends notifications to Slack when:
 * - A user registers for an event
 * - A speaker submits a call for speakers proposal
 *
 * Can be triggered by:
 * - Database triggers (automatic)
 * - Manual test from admin UI
 */

// Environment variables
const SLACK_DEFAULT_BOT_TOKEN = Deno.env.get('SLACK_DEFAULT_BOT_TOKEN');
const SLACK_DEFAULT_TEAM_NAME = Deno.env.get('SLACK_DEFAULT_TEAM_NAME');
const ADMIN_BASE_URL = Deno.env.get('ADMIN_BASE_URL') || 'https://admin.mlops.community';

interface NotifyPayload {
  eventId: string;
  notificationType: 'registration' | 'speaker_submission';
  data?: {
    // Registration data
    firstName?: string;
    lastName?: string;
    email?: string;
    registeredAt?: string;
    registrationId?: string;
    // Speaker submission data
    speakerName?: string;
    talkTitle?: string;
    submittedAt?: string;
    submissionId?: string;
  };
  isTest?: boolean;
  isHistoric?: boolean; // Send all historic registrations/submissions
}

serve(async (req) => {
  try {
    // CORS headers
    if (req.method === 'OPTIONS') {
      return new Response('ok', {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        },
      });
    }

    const payload: NotifyPayload = await req.json();
    const { eventId, notificationType, data, isTest, isHistoric } = payload;

    if (!eventId || !notificationType) {
      return jsonResponse({ error: 'Missing eventId or notificationType' }, 400);
    }

    // Create Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Get notification configuration for this event
    const { data: notificationConfig, error: configError } = await supabaseClient
      .from('events_slack_notifications')
      .select('*')
      .eq('event_id', eventId)
      .eq('notification_type', notificationType)
      .maybeSingle();

    if (configError) {
      console.error('Error fetching notification config:', configError);
      return jsonResponse({ error: 'Failed to fetch notification configuration' }, 500);
    }

    if (!notificationConfig) {
      console.log(`No Slack notification configured for event ${eventId}, type ${notificationType}`);
      return jsonResponse({ message: 'No notification configured', skipped: true }, 200);
    }

    if (!notificationConfig.enabled && !isTest && !isHistoric) {
      console.log(`Slack notification disabled for event ${eventId}, type ${notificationType}`);
      return jsonResponse({ message: 'Notification disabled', skipped: true }, 200);
    }

    // Determine which token to use
    let accessToken: string | null = null;
    let teamName: string = 'Unknown';

    if (notificationConfig.use_custom_workspace) {
      // Get custom workspace token
      const { data: integration } = await supabaseClient
        .from('events_slack_integrations')
        .select('access_token, team_name')
        .eq('event_id', eventId)
        .maybeSingle();

      if (integration) {
        accessToken = integration.access_token;
        teamName = integration.team_name;
      }
    } else {
      // Use brand default
      accessToken = SLACK_DEFAULT_BOT_TOKEN || null;
      teamName = SLACK_DEFAULT_TEAM_NAME || 'Brand Default';
    }

    if (!accessToken) {
      console.error(`No Slack token available for event ${eventId}`);
      await logNotification(supabaseClient, {
        eventId,
        notificationType,
        channelOrUser: notificationConfig.channel_id || notificationConfig.user_id || 'unknown',
        status: 'failed',
        errorMessage: 'No Slack token configured',
        triggerId: data?.registrationId || data?.submissionId || 'test',
        triggerType: notificationType,
      });
      return jsonResponse({ error: 'No Slack token configured' }, 400);
    }

    // Determine destination (channel or user)
    const destination = notificationConfig.channel_id || notificationConfig.user_id;
    if (!destination) {
      console.error(`No destination configured for event ${eventId}`);
      return jsonResponse({ error: 'No channel or user configured' }, 400);
    }

    // Get event details for the message
    const { data: eventData } = await supabaseClient
      .from('events')
      .select('event_title')
      .eq('event_id', eventId)
      .single();

    const eventName = eventData?.event_title || eventId;

    // Handle historic mode - fetch and send all historic data
    if (isHistoric) {
      const historicResult = await sendHistoricNotifications(
        supabaseClient,
        accessToken,
        destination,
        eventId,
        eventName,
        notificationType,
        teamName
      );
      return jsonResponse(historicResult, historicResult.success ? 200 : 500);
    }

    // Build the message
    let message: { text: string; blocks: object[] };

    if (isTest) {
      message = buildTestMessage(eventName, notificationType, teamName);
    } else if (notificationType === 'registration') {
      // Fetch total registration count for real-time notifications
      const { count: totalRegistrations } = await supabaseClient
        .from('events_registrations')
        .select('*', { count: 'exact', head: true })
        .eq('event_id', eventId)
        .eq('status', 'confirmed');

      message = buildRegistrationMessage({
        eventName,
        eventId,
        firstName: data?.firstName || 'Unknown',
        lastName: data?.lastName || 'User',
        email: data?.email || 'unknown@example.com',
        registeredAt: data?.registeredAt || new Date().toISOString(),
        ticketType: (data as any)?.ticketType || undefined,
        amountPaid: (data as any)?.amountPaid || undefined,
        currency: (data as any)?.currency || 'USD',
        totalRegistrations: totalRegistrations ?? undefined,
      });
    } else {
      // Fetch total speaker count for real-time notifications
      // First get the event UUID
      const { data: eventRecord } = await supabaseClient
        .from('events')
        .select('id')
        .eq('event_id', eventId)
        .single();

      let totalSpeakers: number | undefined;
      if (eventRecord) {
        const { count } = await supabaseClient
          .from('events_speakers')
          .select('*', { count: 'exact', head: true })
          .eq('event_uuid', eventRecord.id);
        totalSpeakers = count ?? undefined;
      }

      message = buildSpeakerSubmissionMessage({
        eventName,
        eventId,
        speakerName: data?.speakerName || 'Unknown Speaker',
        talkTitle: data?.talkTitle || 'Untitled Talk',
        submittedAt: data?.submittedAt || new Date().toISOString(),
        jobTitle: (data as any)?.jobTitle || undefined,
        company: (data as any)?.company || undefined,
        totalSpeakers,
      });
    }

    // Send to Slack
    const slackResponse = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: destination,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });

    const slackResult = await slackResponse.json();

    if (!slackResult.ok) {
      console.error('Slack API error:', slackResult.error);
      await logNotification(supabaseClient, {
        eventId,
        notificationType,
        channelOrUser: destination,
        status: 'failed',
        errorMessage: slackResult.error,
        triggerId: data?.registrationId || data?.submissionId || 'test',
        triggerType: notificationType,
        requestPayload: { channel: destination, text: message.text },
        responsePayload: slackResult,
      });
      return jsonResponse({ error: slackResult.error, details: slackResult }, 400);
    }

    console.log(`Successfully sent ${notificationType} notification to ${destination}`);

    // Log success
    await logNotification(supabaseClient, {
      eventId,
      notificationType,
      channelOrUser: destination,
      messageTs: slackResult.ts,
      status: 'sent',
      triggerId: data?.registrationId || data?.submissionId || 'test',
      triggerType: notificationType,
      requestPayload: { channel: destination, text: message.text },
      responsePayload: slackResult,
    });

    return jsonResponse({
      success: true,
      message: 'Notification sent',
      channel: slackResult.channel,
      ts: slackResult.ts,
    }, 200);
  } catch (error) {
    console.error('Unexpected error:', error);
    return jsonResponse({ error: 'Internal server error', details: error.message }, 500);
  }
});

// =============================================================================
// Helper Functions
// =============================================================================

function jsonResponse(data: object, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function logNotification(
  supabase: ReturnType<typeof createClient>,
  params: {
    eventId: string;
    notificationType: string;
    channelOrUser: string;
    messageTs?: string;
    status: 'sent' | 'failed';
    errorMessage?: string;
    triggerId: string;
    triggerType: string;
    requestPayload?: object;
    responsePayload?: object;
  }
) {
  try {
    await supabase.from('slack_notification_logs').insert({
      event_id: params.eventId,
      notification_type: params.notificationType,
      channel_or_user: params.channelOrUser,
      message_ts: params.messageTs,
      status: params.status,
      error_message: params.errorMessage,
      trigger_entity_type: params.triggerType,
      trigger_entity_id: params.triggerId,
      request_payload: params.requestPayload,
      response_payload: params.responsePayload,
    });
  } catch (err) {
    console.error('Failed to log notification:', err);
  }
}

// =============================================================================
// Historic Notifications
// =============================================================================

async function sendHistoricNotifications(
  supabase: ReturnType<typeof createClient>,
  accessToken: string,
  destination: string,
  eventId: string,
  eventName: string,
  notificationType: 'registration' | 'speaker_submission',
  teamName: string
): Promise<{ success: boolean; sent: number; failed: number; total: number; errors?: string[] }> {
  const errors: string[] = [];
  let sent = 0;
  let failed = 0;

  if (notificationType === 'registration') {
    // Fetch all registrations for this event
    const { data: registrations, error } = await supabase
      .from('events_registrations_with_people')
      .select('id, first_name, last_name, email, registered_at, ticket_type, amount_paid, currency')
      .eq('event_id', eventId)
      .eq('status', 'confirmed')
      .order('registered_at', { ascending: true });

    if (error) {
      console.error('Error fetching registrations:', error);
      return { success: false, sent: 0, failed: 0, total: 0, errors: [error.message] };
    }

    const total = registrations?.length || 0;
    console.log(`Found ${total} registrations to send for event ${eventId}`);

    if (total === 0) {
      return { success: true, sent: 0, failed: 0, total: 0 };
    }

    // Send each registration as a separate message with running count
    let registrationCount = 0;
    for (const reg of registrations || []) {
      registrationCount++;
      const message = buildRegistrationMessage({
        eventName,
        eventId,
        firstName: reg.first_name || 'Unknown',
        lastName: reg.last_name || 'User',
        email: reg.email || 'unknown@example.com',
        registeredAt: reg.registered_at || new Date().toISOString(),
        ticketType: reg.ticket_type || undefined,
        amountPaid: reg.amount_paid || undefined,
        currency: reg.currency || 'USD',
        totalRegistrations: registrationCount,
      });

      try {
        const slackResponse = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            channel: destination,
            text: message.text,
            blocks: message.blocks,
            unfurl_links: false,
            unfurl_media: false,
          }),
        });

        const slackResult = await slackResponse.json();

        if (slackResult.ok) {
          sent++;
          // Log success
          await logNotification(supabase, {
            eventId,
            notificationType,
            channelOrUser: destination,
            messageTs: slackResult.ts,
            status: 'sent',
            triggerId: reg.id,
            triggerType: 'registration',
          });
        } else {
          failed++;
          errors.push(`${reg.email}: ${slackResult.error}`);
          await logNotification(supabase, {
            eventId,
            notificationType,
            channelOrUser: destination,
            status: 'failed',
            errorMessage: slackResult.error,
            triggerId: reg.id,
            triggerType: 'registration',
          });
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (err) {
        failed++;
        errors.push(`${reg.email}: ${err.message}`);
      }
    }

    return { success: failed === 0, sent, failed, total, errors: errors.length > 0 ? errors : undefined };
  } else {
    // Speaker submissions - first get the event UUID from event_id
    const { data: eventRecord, error: eventError } = await supabase
      .from('events')
      .select('id')
      .eq('event_id', eventId)
      .single();

    if (eventError || !eventRecord) {
      console.error('Error fetching event UUID:', eventError);
      return { success: false, sent: 0, failed: 0, total: 0, errors: ['Event not found'] };
    }

    // Fetch speaker submissions using the view which includes full_name, job_title, company from people
    const { data: speakers, error } = await supabase
      .from('events_speakers_with_details')
      .select('id, full_name, first_name, last_name, job_title, company, talk_title, submitted_at, created_at, status')
      .eq('event_uuid', eventRecord.id)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching speakers:', error);
      return { success: false, sent: 0, failed: 0, total: 0, errors: [error.message] };
    }

    const total = speakers?.length || 0;
    console.log(`Found ${total} speaker submissions to send for event ${eventId}`);

    if (total === 0) {
      return { success: true, sent: 0, failed: 0, total: 0 };
    }

    // Send each submission as a separate message with running count
    let speakerCount = 0;
    for (const speaker of speakers || []) {
      speakerCount++;
      // Build speaker name from available fields
      const speakerName = speaker.full_name ||
        [speaker.first_name, speaker.last_name].filter(Boolean).join(' ') ||
        'Unknown Speaker';

      const message = buildSpeakerSubmissionMessage({
        eventName,
        eventId,
        speakerName,
        talkTitle: speaker.talk_title || 'Untitled Talk',
        submittedAt: speaker.submitted_at || speaker.created_at || new Date().toISOString(),
        jobTitle: speaker.job_title || undefined,
        company: speaker.company || undefined,
        totalSpeakers: speakerCount,
      });

      try {
        const slackResponse = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            channel: destination,
            text: message.text,
            blocks: message.blocks,
            unfurl_links: false,
            unfurl_media: false,
          }),
        });

        const slackResult = await slackResponse.json();

        if (slackResult.ok) {
          sent++;
          await logNotification(supabase, {
            eventId,
            notificationType,
            channelOrUser: destination,
            messageTs: slackResult.ts,
            status: 'sent',
            triggerId: speaker.id,
            triggerType: 'speaker_submission',
          });
        } else {
          failed++;
          errors.push(`${speakerName}: ${slackResult.error}`);
          await logNotification(supabase, {
            eventId,
            notificationType,
            channelOrUser: destination,
            status: 'failed',
            errorMessage: slackResult.error,
            triggerId: speaker.id,
            triggerType: 'speaker_submission',
          });
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (err) {
        failed++;
        errors.push(`${speakerName}: ${err.message}`);
      }
    }

    return { success: failed === 0, sent, failed, total, errors: errors.length > 0 ? errors : undefined };
  }
}

// =============================================================================
// Message Builders
// =============================================================================

function buildTestMessage(eventName: string, notificationType: string, teamName: string) {
  const typeLabel = notificationType === 'registration' ? 'Registration' : 'Speaker Submission';
  return {
    text: `Test ${typeLabel} notification for ${eventName}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🧪 Test ${typeLabel} Notification`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `This is a test notification for *${eventName}*.\n\nConnected to workspace: *${teamName}*`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Sent at ${new Date().toISOString()}`,
          },
        ],
      },
    ],
  };
}

function buildRegistrationMessage(params: {
  eventName: string;
  eventId: string;
  firstName: string;
  lastName: string;
  email: string;
  registeredAt: string;
  ticketType?: string;
  amountPaid?: number;
  currency?: string;
  totalRegistrations?: number;
}) {
  const adminUrl = `${ADMIN_BASE_URL}/events/${params.eventId}/registrations`;
  const registeredDate = new Date(params.registeredAt).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  // Build ticket info string
  let ticketInfo = '';
  if (params.ticketType) {
    ticketInfo = params.ticketType;
  }
  if (params.amountPaid && params.amountPaid > 0) {
    const currency = params.currency || 'USD';
    const formattedAmount = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
    }).format(params.amountPaid);
    ticketInfo = ticketInfo ? `${ticketInfo} (${formattedAmount})` : formattedAmount;
  }

  // Build fields array
  const fields = [
    {
      type: 'mrkdwn',
      text: `*Attendee:*\n${params.firstName} ${params.lastName}`,
    },
    {
      type: 'mrkdwn',
      text: `*Email:*\n${params.email}`,
    },
  ];

  // Add ticket info if available
  if (ticketInfo) {
    fields.push({
      type: 'mrkdwn',
      text: `*Ticket:*\n${ticketInfo}`,
    });
  }

  // Build context elements
  const contextElements = [
    {
      type: 'mrkdwn',
      text: `Registered: ${registeredDate}`,
    },
  ];

  // Add total count if available
  if (params.totalRegistrations !== undefined) {
    contextElements.push({
      type: 'mrkdwn',
      text: `  |  📊 *Total Registrations: ${params.totalRegistrations}*`,
    });
  }

  return {
    text: `🎉 New registration for ${params.eventName}: ${params.firstName} ${params.lastName}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🎉 New Registration`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${params.eventName}*`,
        },
      },
      {
        type: 'section',
        fields: fields,
      },
      {
        type: 'context',
        elements: contextElements,
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'View in Admin',
              emoji: true,
            },
            url: adminUrl,
            action_id: 'view_registration',
          },
        ],
      },
    ],
  };
}

function buildSpeakerSubmissionMessage(params: {
  eventName: string;
  eventId: string;
  speakerName: string;
  talkTitle: string;
  submittedAt: string;
  jobTitle?: string;
  company?: string;
  totalSpeakers?: number;
}) {
  const adminUrl = `${ADMIN_BASE_URL}/events/${params.eventId}/speakers`;
  const submittedDate = new Date(params.submittedAt).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  // Build speaker info with optional job title and company
  let speakerInfo = params.speakerName;
  if (params.jobTitle && params.company) {
    speakerInfo = `${params.speakerName}\n${params.jobTitle} at ${params.company}`;
  } else if (params.jobTitle) {
    speakerInfo = `${params.speakerName}\n${params.jobTitle}`;
  } else if (params.company) {
    speakerInfo = `${params.speakerName}\n${params.company}`;
  }

  // Build context elements
  const contextElements = [
    {
      type: 'mrkdwn',
      text: `Submitted: ${submittedDate}`,
    },
  ];

  // Add total count if available
  if (params.totalSpeakers !== undefined) {
    contextElements.push({
      type: 'mrkdwn',
      text: `  |  📊 *Total Submissions: ${params.totalSpeakers}*`,
    });
  }

  return {
    text: `🎤 New speaker submission for ${params.eventName}: ${params.speakerName}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🎤 New Speaker Submission`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${params.eventName}*`,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Speaker:*\n${speakerInfo}`,
          },
          {
            type: 'mrkdwn',
            text: `*Talk Title:*\n${params.talkTitle}`,
          },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Status:* 📋 Pending Review`,
        },
      },
      {
        type: 'context',
        elements: contextElements,
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Review Submission',
              emoji: true,
            },
            url: adminUrl,
            action_id: 'review_submission',
            style: 'primary',
          },
        ],
      },
    ],
  };
}
