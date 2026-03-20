import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

interface RsvpRequest {
  action: 'rsvp' | 'track'
  token: string
  rsvp_response?: 'yes' | 'no' | 'maybe'
  rsvp_message?: string | null
  interaction_type?: string
}

export default async function (req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405)
  }

  try {
    const body: RsvpRequest = await req.json()
    const { action, token } = body

    if (!token) {
      return jsonResponse({ success: false, error: 'Token is required' }, 400)
    }

    // Look up the invite
    const { data: invite, error: inviteError } = await supabase
      .from('module_event_invites')
      .select('*')
      .eq('token', token)
      .single()

    if (inviteError || !invite) {
      return jsonResponse({ success: false, error: 'Invite not found' }, 404)
    }

    // Check expiry
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      // Mark as expired
      await supabase
        .from('module_event_invites')
        .update({ status: 'expired' })
        .eq('id', invite.id)

      return jsonResponse({ success: false, error: 'Invite has expired' }, 410)
    }

    // Extract client info for tracking
    const userAgent = req.headers.get('user-agent') || ''
    const forwardedFor = req.headers.get('x-forwarded-for')
    const ipAddress = forwardedFor ? forwardedFor.split(',')[0].trim() : null

    if (action === 'track') {
      // Track an interaction (page open, link click, etc.)
      const interactionType = body.interaction_type || 'opened'

      await supabase.from('module_event_invite_interactions').insert({
        invite_id: invite.id,
        interaction_type: interactionType,
        ip_address: ipAddress,
        user_agent: userAgent,
      })

      // Update invite tracking counters
      const updates: Record<string, unknown> = {
        total_clicks: (invite.total_clicks || 0) + 1,
        last_clicked_at: new Date().toISOString(),
      }

      // Mark as opened if first time
      if (invite.status === 'pending' || invite.status === 'sent') {
        updates.status = 'opened'
        updates.opened_at = new Date().toISOString()
      }

      await supabase
        .from('module_event_invites')
        .update(updates)
        .eq('id', invite.id)

      return jsonResponse({ success: true })
    }

    if (action === 'rsvp') {
      const { rsvp_response, rsvp_message } = body

      if (!rsvp_response || !['yes', 'no', 'maybe'].includes(rsvp_response)) {
        return jsonResponse({ success: false, error: 'Invalid RSVP response' }, 400)
      }

      // Determine new status
      const newStatus = rsvp_response === 'yes' ? 'accepted' : rsvp_response === 'no' ? 'declined' : 'opened'

      // Update invite
      const { error: updateError } = await supabase
        .from('module_event_invites')
        .update({
          rsvp_response,
          rsvp_message: rsvp_message || null,
          rsvp_responded_at: new Date().toISOString(),
          status: newStatus,
        })
        .eq('id', invite.id)

      if (updateError) {
        console.error('Error updating invite:', updateError)
        return jsonResponse({ success: false, error: 'Failed to update RSVP' }, 500)
      }

      // Track the RSVP interaction
      await supabase.from('module_event_invite_interactions').insert({
        invite_id: invite.id,
        interaction_type: `rsvp_${rsvp_response}`,
        ip_address: ipAddress,
        user_agent: userAgent,
        metadata: rsvp_message ? { message: rsvp_message } : {},
      })

      // If accepted and the invite has a people_profile_id, auto-register for the event
      if (rsvp_response === 'yes' && invite.people_profile_id) {
        // Check if already registered
        const { data: existingReg } = await supabase
          .from('events_registrations')
          .select('id')
          .eq('event_id', invite.event_id)
          .eq('people_profile_id', invite.people_profile_id)
          .maybeSingle()

        if (!existingReg) {
          const { data: reg } = await supabase
            .from('events_registrations')
            .insert({
              event_id: invite.event_id,
              people_profile_id: invite.people_profile_id,
              registration_type: 'free',
              registration_source: 'invite',
              status: 'confirmed',
              registration_metadata: { invite_id: invite.id },
            })
            .select('id')
            .single()

          if (reg) {
            // Link registration back to invite
            await supabase
              .from('module_event_invites')
              .update({ registration_id: reg.id })
              .eq('id', invite.id)
          }
        }
      }

      // Update batch counters if invite belongs to a batch
      if (invite.batch_id) {
        const countField = rsvp_response === 'yes' ? 'accepted_count' : rsvp_response === 'no' ? 'declined_count' : null
        if (countField) {
          const { data: batch } = await supabase
            .from('module_event_invite_batches')
            .select(countField)
            .eq('id', invite.batch_id)
            .single()

          if (batch) {
            await supabase
              .from('module_event_invite_batches')
              .update({ [countField]: (batch[countField] || 0) + 1 })
              .eq('id', invite.batch_id)
          }
        }
      }

      return jsonResponse({
        success: true,
        rsvp_response,
        message: rsvp_response === 'yes'
          ? 'Thank you! You are registered for the event.'
          : rsvp_response === 'maybe'
          ? 'Thanks! We hope to see you there.'
          : 'Thank you for letting us know.',
      })
    }

    return jsonResponse({ success: false, error: 'Invalid action' }, 400)
  } catch (error) {
    console.error('Error processing request:', error)
    return jsonResponse({ success: false, error: 'Internal server error' }, 500)
  }
}
