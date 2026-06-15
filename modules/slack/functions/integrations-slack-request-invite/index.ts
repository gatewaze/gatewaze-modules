import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * integrations-slack-request-invite
 *
 * Public enqueue endpoint for Slack workspace invitations — the new-setup
 * equivalent of gatewaze-admin's POST /api/slack/invite. Adds the email to
 * public.integrations_slack_invitation_queue via integrations_request_slack_invitation
 * (which dedups against pending / recently-completed requests). The
 * slack-invitation-worker drains the queue and sends the invite via the Slack
 * admin UI.
 *
 * Auth: the gateway verifies the JWT (callers send the project anon key); the
 * enqueue itself runs with the service role through a SECURITY DEFINER RPC.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const { email, account, metadata } = await req.json();

    if (!email || !String(email).includes('@')) {
      return new Response(JSON.stringify({ success: false, error: 'Valid email address is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const normalizedEmail = String(email).toLowerCase().trim();

    const { data, error } = await supabase.rpc('integrations_request_slack_invitation', {
      p_email: normalizedEmail,
      p_account: account ?? 'default',
      p_metadata: metadata ?? { source: 'frontend' },
    });

    if (error) {
      console.error('Error enqueuing Slack invitation:', error);
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Slack invitation request received. You will receive an email invitation shortly.',
      invitationId: data,
      status: 'pending',
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('Error in integrations-slack-request-invite:', err);
    return new Response(JSON.stringify({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to request invitation',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
