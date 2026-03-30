import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Speaker Update Notification Edge Function
 *
 * Handles notifications when a speaker updates their submission.
 * IMPORTANT: Different behavior for each integration:
 * - Slack: Sends a NEW message (notification of the update)
 * - Google Sheets: UPDATES the existing row (keeps data in sync)
 */

// Environment variables
const SLACK_DEFAULT_BOT_TOKEN = Deno.env.get('SLACK_DEFAULT_BOT_TOKEN');
const SLACK_DEFAULT_TEAM_NAME = Deno.env.get('SLACK_DEFAULT_TEAM_NAME');
const ADMIN_BASE_URL = Deno.env.get('ADMIN_BASE_URL') || 'https://admin.mlops.community';

// Google Sheets
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_SHEETS_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_SHEETS_CLIENT_SECRET');

interface UpdateNotifyPayload {
  eventId: string;
  notificationType: 'speaker_update';
  data: {
    speakerId: string;
    speakerName: string;
    email: string;
    talkTitle: string;
    talkSynopsis?: string;
    speakerBio?: string;
    jobTitle?: string;
    company?: string;
    linkedinUrl?: string;
    avatarUrl?: string;
    status: string;
    changes: Record<string, { old: string; new: string }>;
    updatedAt: string;
  };
}

interface NotifyResult {
  slack: { sent: boolean; error?: string };
  sheets: { sent: boolean; error?: string; action?: 'updated' | 'appended' };
}

export default async function(req: Request) {
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

    const payload: UpdateNotifyPayload = await req.json();
    const { eventId, data } = payload;

    if (!eventId || !data?.speakerId) {
      return jsonResponse({ error: 'Missing eventId or speakerId' }, 400);
    }

    // Create Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const results: NotifyResult = {
      slack: { sent: false },
      sheets: { sent: false },
    };

    // Get event details
    const { data: eventData } = await supabaseClient
      .from('events')
      .select('event_title')
      .eq('event_id', eventId)
      .single();

    const eventName = eventData?.event_title || eventId;

    // ==========================================================================
    // 1. SLACK: Send NEW message about the update
    // ==========================================================================

    const { data: slackConfig } = await supabaseClient
      .from('events_slack_notifications')
      .select('*')
      .eq('event_id', eventId)
      .eq('notification_type', 'speaker_update')
      .eq('enabled', true)
      .maybeSingle();

    if (slackConfig && (slackConfig.channel_id || slackConfig.user_id)) {
      try {
        // Determine which token to use
        let accessToken: string | null = null;
        let teamName = 'Unknown';

        if (slackConfig.use_custom_workspace) {
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
          accessToken = SLACK_DEFAULT_BOT_TOKEN || null;
          teamName = SLACK_DEFAULT_TEAM_NAME || 'Brand Default';
        }

        if (accessToken) {
          const destination = slackConfig.channel_id || slackConfig.user_id;
          const message = buildSlackUpdateMessage(eventName, eventId, data);

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
            results.slack.sent = true;
            console.log(`Slack update notification sent for speaker ${data.speakerId}`);

            // Log success
            await supabaseClient.from('slack_notification_logs').insert({
              event_id: eventId,
              notification_type: 'speaker_update',
              channel_or_user: destination,
              message_ts: slackResult.ts,
              status: 'sent',
              trigger_entity_type: 'speaker_update',
              trigger_entity_id: data.speakerId,
            });
          } else {
            results.slack.error = slackResult.error;
            console.error('Slack API error:', slackResult.error);

            await supabaseClient.from('slack_notification_logs').insert({
              event_id: eventId,
              notification_type: 'speaker_update',
              channel_or_user: destination,
              status: 'failed',
              error_message: slackResult.error,
              trigger_entity_type: 'speaker_update',
              trigger_entity_id: data.speakerId,
            });
          }
        } else {
          results.slack.error = 'No Slack token available';
        }
      } catch (error) {
        results.slack.error = error.message;
        console.error('Slack notification error:', error);
      }
    }

    // ==========================================================================
    // 2. GOOGLE SHEETS: UPDATE existing row (or append if not found)
    // ==========================================================================

    const { data: sheetsConfig } = await supabaseClient
      .from('events_google_sheets_notifications')
      .select('*')
      .eq('event_id', eventId)
      .eq('notification_type', 'speaker_submission')
      .eq('enabled', true)
      .maybeSingle();

    if (sheetsConfig?.spreadsheet_id && sheetsConfig?.google_refresh_token) {
      try {
        const accessToken = await getValidAccessToken(supabaseClient, sheetsConfig);

        if (accessToken) {
          const sheetName = sheetsConfig.sheet_name || 'Sheet1';

          // Find the row by speaker ID (column L)
          const rowIndex = await findRowBySpeakerId(
            accessToken,
            sheetsConfig.spreadsheet_id,
            sheetName,
            data.speakerId
          );

          const rowData = buildSheetRowData(data);

          if (rowIndex) {
            // Update existing row
            const updateResult = await updateSheetRow(
              accessToken,
              sheetsConfig.spreadsheet_id,
              sheetName,
              rowIndex,
              rowData
            );

            if (updateResult.success) {
              results.sheets.sent = true;
              results.sheets.action = 'updated';
              console.log(`Updated row ${rowIndex} in Google Sheet for speaker ${data.speakerId}`);

              await supabaseClient.from('integrations_google_sheets_notification_logs').insert({
                event_id: eventId,
                notification_type: 'speaker_submission',
                spreadsheet_id: sheetsConfig.spreadsheet_id,
                sheet_name: sheetName,
                status: 'updated',
                trigger_entity_type: 'speaker_update',
                trigger_entity_id: data.speakerId,
                row_data: rowData,
                row_number: rowIndex,
              });
            } else {
              results.sheets.error = updateResult.error;
            }
          } else {
            // Row not found - append new row
            const appendResult = await appendToSheet(
              accessToken,
              sheetsConfig.spreadsheet_id,
              sheetName,
              rowData
            );

            if (appendResult.success) {
              results.sheets.sent = true;
              results.sheets.action = 'appended';
              console.log(`Appended new row to Google Sheet for speaker ${data.speakerId} (not found in existing data)`);

              await supabaseClient.from('integrations_google_sheets_notification_logs').insert({
                event_id: eventId,
                notification_type: 'speaker_submission',
                spreadsheet_id: sheetsConfig.spreadsheet_id,
                sheet_name: sheetName,
                status: 'sent',
                trigger_entity_type: 'speaker_update',
                trigger_entity_id: data.speakerId,
                row_data: rowData,
              });
            } else {
              results.sheets.error = appendResult.error;
            }
          }
        } else {
          results.sheets.error = 'Failed to get Google API access token';
        }
      } catch (error) {
        results.sheets.error = error.message;
        console.error('Google Sheets error:', error);
      }
    }

    return jsonResponse({
      success: results.slack.sent || results.sheets.sent,
      results,
    }, 200);
  } catch (error) {
    console.error('Unexpected error:', error);
    return jsonResponse({ error: 'Internal server error', details: (error as any).message }, 500);
  }
}

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

/**
 * Build Slack message showing what changed
 */
function buildSlackUpdateMessage(
  eventName: string,
  eventId: string,
  data: UpdateNotifyPayload['data']
) {
  const adminUrl = `${ADMIN_BASE_URL}/events/${eventId}/speakers`;

  // Build changes text
  const fieldLabels: Record<string, string> = {
    talk_title: 'Talk Title',
    talk_synopsis: 'Talk Synopsis',
    speaker_bio: 'Bio',
  };

  const changedFields = Object.keys(data.changes || {});
  const changesText = changedFields.length > 0
    ? changedFields.map(f => `  *${fieldLabels[f] || f}* updated`).join('\n')
    : '  _No specific changes tracked_';

  // Build speaker info
  let speakerInfo = data.speakerName;
  if (data.jobTitle && data.company) {
    speakerInfo = `${data.speakerName}\n${data.jobTitle} at ${data.company}`;
  } else if (data.jobTitle) {
    speakerInfo = `${data.speakerName}\n${data.jobTitle}`;
  } else if (data.company) {
    speakerInfo = `${data.speakerName}\n${data.company}`;
  }

  const updatedDate = new Date(data.updatedAt).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return {
    text: `Speaker submission updated for ${eventName}: ${data.speakerName}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'Speaker Submission Updated',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${eventName}*`,
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
            text: `*Talk:*\n${data.talkTitle || 'Untitled'}`,
          },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Changes:*\n${changesText}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Updated: ${updatedDate}`,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'View Submission',
              emoji: true,
            },
            url: adminUrl,
            action_id: 'view_speaker_update',
          },
        ],
      },
    ],
  };
}

/**
 * Build row data for Google Sheets
 * Columns: A-L (Timestamp, Name, Email, Job Title, Company, LinkedIn, Avatar, Talk Title, Synopsis, Bio, Status, Speaker ID)
 */
function buildSheetRowData(data: UpdateNotifyPayload['data']): string[] {
  return [
    data.updatedAt || new Date().toISOString(),
    data.speakerName || '',
    data.email || '',
    data.jobTitle || '',
    data.company || '',
    data.linkedinUrl || '',
    data.avatarUrl || '',
    data.talkTitle || '',
    data.talkSynopsis || '',
    data.speakerBio || '',
    data.status || 'pending',
    data.speakerId || '',
  ];
}

/**
 * Find row by speaker ID in column L
 */
async function findRowBySpeakerId(
  accessToken: string,
  spreadsheetId: string,
  sheetName: string,
  speakerId: string
): Promise<number | null> {
  try {
    const range = `${sheetName}!L:L`;
    const url = `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    const result = await response.json();
    const values = result.values || [];

    // Find the row index (1-based for Sheets API)
    for (let i = 0; i < values.length; i++) {
      if (values[i][0] === speakerId) {
        return i + 1; // Sheets uses 1-based indexing
      }
    }

    return null;
  } catch (error) {
    console.error('Error finding row by speaker ID:', error);
    return null;
  }
}

/**
 * Update a specific row in Google Sheet
 */
async function updateSheetRow(
  accessToken: string,
  spreadsheetId: string,
  sheetName: string,
  rowIndex: number,
  rowData: string[]
): Promise<{ success: boolean; error?: string }> {
  try {
    const range = `${sheetName}!A${rowIndex}:L${rowIndex}`;
    const url = `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        values: [rowData],
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('Google Sheets update error:', result);
      return {
        success: false,
        error: result.error?.message || 'Failed to update row',
      };
    }

    return { success: true };
  } catch (error) {
    console.error('Error updating sheet row:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Append a row to Google Sheet
 */
async function appendToSheet(
  accessToken: string,
  spreadsheetId: string,
  sheetName: string,
  rowData: string[]
): Promise<{ success: boolean; error?: string }> {
  try {
    const range = `${sheetName}!A:L`;
    const url = `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        values: [rowData],
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('Google Sheets append error:', result);
      return {
        success: false,
        error: result.error?.message || 'Failed to append row',
      };
    }

    return { success: true };
  } catch (error) {
    console.error('Error appending to sheet:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Get a valid access token, refreshing if necessary
 * Uses OAuth tokens stored per-event (not service account)
 */
async function getValidAccessToken(
  supabase: ReturnType<typeof createClient>,
  config: {
    id: string;
    google_access_token: string | null;
    google_refresh_token: string | null;
    google_token_expires_at: string | null;
  }
): Promise<string | null> {
  // Check if current token is still valid
  if (config.google_access_token && config.google_token_expires_at) {
    const expiresAt = new Date(config.google_token_expires_at);
    const now = new Date();
    // Add 5 minute buffer before expiry
    if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) {
      return config.google_access_token;
    }
  }

  // Need to refresh the token
  if (!config.google_refresh_token) {
    console.error('No refresh token available');
    return null;
  }

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.error('Google OAuth client credentials not configured');
    return null;
  }

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: config.google_refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error('Token refresh failed:', errorData);
      return null;
    }

    const tokens = await tokenResponse.json();
    const { access_token, expires_in } = tokens;

    if (!access_token) {
      console.error('No access token in refresh response');
      return null;
    }

    // Calculate new expiry time
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    // Update tokens in database
    const { error: updateError } = await supabase
      .from('events_google_sheets_notifications')
      .update({
        google_access_token: access_token,
        google_token_expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', config.id);

    if (updateError) {
      console.error('Failed to update tokens:', updateError);
      // Still return the token even if we couldn't save it
    }

    return access_token;
  } catch (error) {
    console.error('Error refreshing token:', error);
    return null;
  }
}
