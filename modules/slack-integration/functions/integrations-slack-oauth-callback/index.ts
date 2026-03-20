import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Slack OAuth Callback Handler
 * Exchanges authorization code for access token and stores in database
 *
 * Flow:
 * 1. User clicks "Connect Custom Workspace" in admin
 * 2. Redirected to Slack OAuth consent screen
 * 3. Slack redirects back here with code and state (eventId)
 * 4. We exchange code for tokens and store in event_slack_integrations
 * 5. Redirect user back to admin with success/error status
 */

const SLACK_CLIENT_ID = Deno.env.get('SLACK_CLIENT_ID')!;
const SLACK_CLIENT_SECRET = Deno.env.get('SLACK_CLIENT_SECRET')!;
const ADMIN_BASE_URL = Deno.env.get('ADMIN_BASE_URL') || 'https://admin.mlops.community';

serve(async (req) => {
  try {
    const url = new URL(req.url);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response('ok', {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        },
      });
    }

    // Get OAuth parameters from query string
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state'); // This is the eventId
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    // Handle OAuth errors
    if (error) {
      console.error('Slack OAuth error:', error, errorDescription);
      return redirectToAdmin(state, false, errorDescription || error);
    }

    // Validate required parameters
    if (!code) {
      console.error('Missing authorization code');
      return redirectToAdmin(state, false, 'Missing authorization code');
    }

    if (!state) {
      console.error('Missing state (event ID)');
      return redirectToAdmin(null, false, 'Missing event ID');
    }

    // Validate environment variables
    if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
      console.error('Missing Slack credentials in environment');
      return redirectToAdmin(state, false, 'Slack integration not configured');
    }

    // Exchange code for access token
    const tokenResponse = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: SLACK_CLIENT_ID,
        client_secret: SLACK_CLIENT_SECRET,
        code: code,
        redirect_uri: `${Deno.env.get('SUPABASE_URL')}/functions/v1/slack-oauth-callback`,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenData.ok) {
      console.error('Failed to exchange code for token:', tokenData.error);
      return redirectToAdmin(state, false, tokenData.error || 'Failed to connect Slack');
    }

    console.log('Successfully obtained Slack access token for team:', tokenData.team?.name);

    // Create Supabase client with service role to store tokens
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Store the integration in the database
    const { error: dbError } = await supabaseClient
      .from('events_slack_integrations')
      .upsert(
        {
          event_id: state,
          access_token: tokenData.access_token,
          bot_user_id: tokenData.bot_user_id,
          team_id: tokenData.team.id,
          team_name: tokenData.team.name,
          scope: tokenData.scope,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: 'event_id',
        }
      );

    if (dbError) {
      console.error('Failed to store Slack integration:', dbError);
      return redirectToAdmin(state, false, 'Failed to save Slack connection');
    }

    console.log('Successfully stored Slack integration for event:', state);

    // Redirect back to admin with success
    return redirectToAdmin(state, true);
  } catch (err) {
    console.error('Unexpected error in Slack OAuth callback:', err);
    return redirectToAdmin(null, false, 'An unexpected error occurred');
  }
});

/**
 * Redirect user back to admin app with status
 */
function redirectToAdmin(eventId: string | null, success: boolean, errorMessage?: string): Response {
  let redirectUrl: string;

  if (eventId) {
    redirectUrl = `${ADMIN_BASE_URL}/events/${eventId}/communications?tab=slack`;
  } else {
    redirectUrl = `${ADMIN_BASE_URL}/events`;
  }

  // Add status parameters
  const params = new URLSearchParams();
  if (success) {
    params.set('slack_connected', 'true');
  } else {
    params.set('slack_error', errorMessage || 'Connection failed');
  }

  redirectUrl += (redirectUrl.includes('?') ? '&' : '?') + params.toString();

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectUrl,
    },
  });
}
