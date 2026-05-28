// @ts-nocheck — portal deps are resolved at build time via webpack alias
import { createClient } from '@supabase/supabase-js'
import { InviteRsvpClient } from '../components/InviteRsvpClient'

interface Props {
  params: { token: string }
  apiUrl?: string
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key, {
    global: { fetch: (url, options = {}) => fetch(url, { ...options, cache: 'no-store' }) },
  })
}

async function loadParty(tokenOrCode: string) {
  const supabase = getSupabase()
  if (!supabase) return null

  // Resolve party — short codes are ≤12 chars, tokens are 64 chars
  const field = tokenOrCode.length <= 12 ? 'short_code' : 'token'
  const { data: party, error: partyErr } = await supabase
    .from('invite_parties')
    .select('id, name, status, max_plus_ones, plus_ones_added, version, short_code')
    .eq(field, tokenOrCode)
    .single()

  if (partyErr || !party) return null
  if (party.status === 'cancelled') return { error: 'INVITE_CANCELLED' }

  // Get members
  const { data: members } = await supabase
    .from('invite_party_members')
    .select('id, first_name, last_name, email, is_lead_booker, is_plus_one, sort_order')
    .eq('party_id', party.id)
    .order('sort_order')

  if (!members) return null

  // Get member-event mappings
  const memberIds = members.map(m => m.id)
  const { data: memberEvents } = await supabase
    .from('invite_party_member_events')
    .select('id, party_member_id, event_id, sub_event_id, rsvp_status, rsvp_deadline, rsvp_responded_at')
    .in('party_member_id', memberIds)

  // Get event details
  const eventIds = [...new Set((memberEvents || []).map(me => me.event_id))]
  const { data: events } = eventIds.length > 0
    ? await supabase.from('events').select('id, event_title, event_start, event_end, event_location').in('id', eventIds)
    : { data: [] }
  const eventMap = new Map((events || []).map(e => [e.id, e]))

  // Get sub-events
  const subEventIds = [...new Set((memberEvents || []).map(me => me.sub_event_id).filter(Boolean))]
  const { data: subEventsData } = subEventIds.length > 0
    ? await supabase.from('invite_sub_events').select('id, name, description, starts_at, ends_at, rsvp_deadline').in('id', subEventIds)
    : { data: [] }
  const subEventMap = new Map((subEventsData || []).map(se => [se.id, se]))

  // Get questions
  const { data: questions } = eventIds.length > 0
    ? await supabase.from('invite_questions').select('*').in('event_id', eventIds).order('sort_order')
    : { data: [] }

  // Get existing responses
  const memberEventIds = (memberEvents || []).map(me => me.id)
  const { data: responses } = memberEventIds.length > 0
    ? await supabase.from('invite_responses').select('party_member_event_id, question_id, answer').in('party_member_event_id', memberEventIds)
    : { data: [] }

  const responseMap = new Map()
  for (const r of responses || []) {
    if (!responseMap.has(r.party_member_event_id)) responseMap.set(r.party_member_event_id, new Map())
    responseMap.get(r.party_member_event_id).set(r.question_id, r.answer)
  }

  // Build response
  const membersWithEvents = members.map(member => ({
    id: member.id,
    first_name: member.first_name,
    last_name: member.last_name,
    is_lead_booker: member.is_lead_booker,
    is_plus_one: member.is_plus_one,
    events: (memberEvents || [])
      .filter(me => me.party_member_id === member.id)
      .map(me => {
        const event = eventMap.get(me.event_id)
        const subEvent = me.sub_event_id ? subEventMap.get(me.sub_event_id) : null
        return {
          member_event_id: me.id,
          event_id: me.event_id,
          sub_event_id: me.sub_event_id || null,
          event_title: subEvent?.name || event?.event_title || '',
          event_start: subEvent?.starts_at || event?.event_start || null,
          event_end: subEvent?.ends_at || event?.event_end || null,
          event_location: event?.event_location || null,
          sub_event_name: subEvent?.name || null,
          rsvp_status: me.rsvp_status,
          rsvp_deadline: me.rsvp_deadline || subEvent?.rsvp_deadline || null,
          rsvp_responded_at: me.rsvp_responded_at,
          questions: (questions || [])
            .filter(q => {
              if (q.event_id !== me.event_id) return false
              // Strict matching: sub-event questions only for that sub-event,
              // parent-event questions only when member has no sub-event
              if (me.sub_event_id) return q.sub_event_id === me.sub_event_id
              return !q.sub_event_id
            })
            .filter(q => q.applies_to === 'all' || (q.applies_to === 'accepted_only' && me.rsvp_status === 'accepted'))
            .map(q => ({
              id: q.id,
              question_text: q.question_text,
              question_type: q.question_type,
              options: q.options,
              is_required: q.is_required,
              current_answer: responseMap.get(me.id)?.get(q.id) ?? null,
            })),
        }
      }),
  }))

  // Mark as opened on first load
  if (party.status === 'sent') {
    await supabase
      .from('invite_parties')
      .update({ status: 'opened', opened_at: new Date().toISOString() })
      .eq('id', party.id)
  }

  // Track interaction
  await supabase.from('event_invite_interactions').insert({
    party_id: party.id,
    interaction_type: 'opened',
  }).then(() => {}, () => {}) // fire-and-forget

  return {
    party: {
      id: party.id,
      name: party.name,
      status: party.status === 'sent' ? 'opened' : party.status,
      max_plus_ones: party.max_plus_ones,
      plus_ones_added: party.plus_ones_added,
      version: party.version,
    },
    members: membersWithEvents,
  }
}

async function getBrandConfig() {
  const supabase = getSupabase()
  if (!supabase) return { name: '', primaryColor: '#6366f1', secondaryColor: '#1e1b4b', domain: '' }

  const { data } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'brand_config')
    .maybeSingle()

  if (data?.value) {
    const config = typeof data.value === 'string' ? JSON.parse(data.value) : data.value
    return {
      name: config.name || '',
      primaryColor: config.primaryColor || '#6366f1',
      secondaryColor: config.secondaryColor || '#1e1b4b',
      domain: config.domain || '',
    }
  }

  return { name: '', primaryColor: '#6366f1', secondaryColor: '#1e1b4b', domain: '' }
}

export default async function InviteRsvpPage({ params }: Props) {
  const { token } = params
  const [result, brand] = await Promise.all([loadParty(token), getBrandConfig()])

  if (!result || result.error) {
    const isExpired = result?.error === 'INVITE_EXPIRED'
    const isCancelled = result?.error === 'INVITE_CANCELLED'

    return (
      <div className="min-h-[60vh] flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-md p-6 text-center">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
            style={{ backgroundColor: isExpired ? '#fef3c7' : '#fee2e2' }}
          >
            {isExpired ? (
              <svg className="w-8 h-8 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
          </div>
          <h1 className="text-xl font-semibold text-gray-900 mb-2">
            {isExpired ? 'Invitation expired' : isCancelled ? 'Invitation cancelled' : 'Invitation not found'}
          </h1>
          <p className="text-gray-600 mb-4">
            {isExpired
              ? 'The RSVP deadline for this invitation has passed.'
              : isCancelled
              ? 'This invitation has been cancelled by the organiser.'
              : 'This invitation link is invalid or has expired.'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <InviteRsvpClient
        party={result.party}
        members={result.members}
        token={token}
        primaryColor={brand.primaryColor}
        brandName={brand.name}
      />
    </div>
  )
}
