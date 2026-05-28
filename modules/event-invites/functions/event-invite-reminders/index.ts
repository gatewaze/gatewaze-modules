import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/**
 * Scheduled edge function that runs daily to send RSVP reminders.
 *
 * For each enabled reminder config:
 * 1. Find parties with pending member-events whose rsvp_deadline is
 *    within `days_before_deadline` days from now
 * 2. Exclude parties already reminded (in invite_reminder_log)
 * 3. Send reminders via each party's delivery channel
 * 4. Log each send
 */
export default async function (_req: Request) {
  try {
    console.log('[event-invite-reminders] Starting reminder processing...')

    // Get all enabled reminder configs
    const { data: configs, error: configErr } = await supabase
      .from('invite_reminder_config')
      .select('*')
      .eq('enabled', true)

    if (configErr) {
      console.error('[event-invite-reminders] Error fetching configs:', configErr)
      return new Response(JSON.stringify({ error: 'Failed to fetch configs' }), { status: 500 })
    }

    if (!configs || configs.length === 0) {
      console.log('[event-invite-reminders] No active reminder configs found')
      return new Response(JSON.stringify({ processed: 0 }))
    }

    let totalSent = 0

    for (const config of configs) {
      const deadlineThreshold = new Date()
      deadlineThreshold.setDate(deadlineThreshold.getDate() + config.days_before_deadline)

      // Find parties with pending member-events for this event
      // whose deadline is within the threshold
      const { data: pendingMemberEvents } = await supabase
        .from('invite_party_member_events')
        .select(`
          id,
          party_member_id,
          event_id,
          rsvp_deadline,
          invite_party_members!inner (
            party_id
          )
        `)
        .eq('event_id', config.event_id)
        .eq('rsvp_status', 'pending')
        .not('rsvp_deadline', 'is', null)
        .lte('rsvp_deadline', deadlineThreshold.toISOString())
        .gt('rsvp_deadline', new Date().toISOString()) // not yet expired

      if (!pendingMemberEvents || pendingMemberEvents.length === 0) continue

      // Get unique party IDs
      const partyIds = [...new Set(
        pendingMemberEvents.map(me => {
          const member = me.invite_party_members as Record<string, unknown>
          return member?.party_id as string
        }).filter(Boolean)
      )]

      // Exclude already-reminded parties
      const { data: alreadyReminded } = await supabase
        .from('invite_reminder_log')
        .select('party_id')
        .eq('reminder_config_id', config.id)
        .in('party_id', partyIds)

      const remindedSet = new Set((alreadyReminded || []).map(r => r.party_id))
      const partiesToRemind = partyIds.filter(id => !remindedSet.has(id))

      if (partiesToRemind.length === 0) continue

      // Get party details for sending
      const { data: parties } = await supabase
        .from('invite_parties')
        .select('id, name, short_code, delivery_channel, status')
        .in('id', partiesToRemind)
        .in('status', ['sent', 'opened', 'partially_responded'])

      if (!parties || parties.length === 0) continue

      for (const party of parties) {
        try {
          // Get lead booker
          const { data: leadBooker } = await supabase
            .from('invite_party_members')
            .select('first_name, last_name, email, phone')
            .eq('party_id', party.id)
            .eq('is_lead_booker', true)
            .single()

          if (!leadBooker?.email && party.delivery_channel === 'email') continue

          if (party.delivery_channel === 'email' && leadBooker?.email) {
            // Get event details
            const { data: event } = await supabase
              .from('events')
              .select('event_title, event_start, event_location')
              .eq('id', config.event_id)
              .single()

            const portalUrl = Deno.env.get('PORTAL_URL') || ''
            const rsvpLink = `${portalUrl}/rsvp/${party.short_code}`

            // Create email batch job for reminder
            await supabase
              .from('email_batch_jobs')
              .insert({
                event_id: config.event_id,
                email_type: 'invite_reminder',
                template_id: config.template_id,
                subject_template: `Reminder: RSVP for ${event?.event_title || 'Event'}`,
                status: 'pending',
                total_recipients: 1,
                errors: [{
                  type: 'template_vars',
                  to_email: leadBooker.email,
                  variables: {
                    party_name: party.name,
                    lead_first_name: leadBooker.first_name || '',
                    lead_last_name: leadBooker.last_name || '',
                    rsvp_link: rsvpLink,
                    event_title: event?.event_title || '',
                    event_date: event?.event_start || '',
                    event_location: event?.event_location || '',
                  },
                }],
              })
          }

          // Log the reminder
          await supabase
            .from('invite_reminder_log')
            .insert({
              reminder_config_id: config.id,
              party_id: party.id,
              delivery_channel: party.delivery_channel,
            })

          totalSent++
        } catch (err) {
          console.error(`[event-invite-reminders] Error sending reminder to party ${party.id}:`, err)
        }
      }
    }

    console.log(`[event-invite-reminders] Done. Sent ${totalSent} reminders.`)
    return new Response(JSON.stringify({ success: true, reminders_sent: totalSent }))
  } catch (error) {
    console.error('[event-invite-reminders] Fatal error:', error)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 })
  }
}
