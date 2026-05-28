import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
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

// ---------- Rate Limiting ----------

async function checkRateLimit(partyId: string, action: string): Promise<boolean> {
  const limit = action === 'submit' ? 3 : 10
  const { count } = await supabase
    .from('event_invite_interactions')
    .select('*', { count: 'exact', head: true })
    .eq('party_id', partyId)
    .gte('created_at', new Date(Date.now() - 60_000).toISOString())

  return (count || 0) < limit
}

// ---------- Resolve Token ----------

async function resolveParty(token: string) {
  // Short codes are ≤12 chars, tokens are always 64 chars
  const field = token.length <= 12 ? 'short_code' : 'token'

  const { data, error } = await supabase
    .from('invite_parties')
    .select('id, name, status, max_plus_ones, plus_ones_added, version, short_code')
    .eq(field, token)
    .single()

  if (error || !data) return null
  return data
}

// ---------- Load Action ----------

async function handleLoad(token: string) {
  const party = await resolveParty(token)

  if (!party) {
    return jsonResponse({ error: 'INVITE_NOT_FOUND', message: 'This invite link is not valid.' }, 404)
  }

  if (party.status === 'cancelled') {
    return jsonResponse({ error: 'INVITE_CANCELLED', message: 'This invite has been cancelled.' }, 403)
  }

  if (!await checkRateLimit(party.id, 'load')) {
    return jsonResponse({ error: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' }, 429)
  }

  // Get members with their event assignments
  const { data: members } = await supabase
    .from('invite_party_members')
    .select('id, first_name, last_name, email, is_lead_booker, is_plus_one, sort_order')
    .eq('party_id', party.id)
    .order('sort_order')

  if (!members) {
    return jsonResponse({ error: 'INTERNAL_ERROR', message: 'Failed to load party members' }, 500)
  }

  // Get all member-event mappings
  const memberIds = members.map(m => m.id)
  const { data: memberEvents } = await supabase
    .from('invite_party_member_events')
    .select('id, party_member_id, event_id, rsvp_status, rsvp_deadline, rsvp_responded_at')
    .in('party_member_id', memberIds)

  // Get unique event IDs and fetch event details
  const eventIds = [...new Set((memberEvents || []).map(me => me.event_id))]
  const { data: events } = await supabase
    .from('events')
    .select('id, event_title, event_start, event_end, event_location')
    .in('id', eventIds)

  const eventMap = new Map((events || []).map(e => [e.id, e]))

  // Get questions for these events
  const { data: questions } = await supabase
    .from('invite_questions')
    .select('*')
    .in('event_id', eventIds)
    .order('sort_order')

  // Get existing responses
  const memberEventIds = (memberEvents || []).map(me => me.id)
  const { data: responses } = memberEventIds.length > 0
    ? await supabase
        .from('invite_responses')
        .select('party_member_event_id, question_id, answer')
        .in('party_member_event_id', memberEventIds)
    : { data: [] }

  const responseMap = new Map<string, Map<string, unknown>>()
  for (const r of responses || []) {
    if (!responseMap.has(r.party_member_event_id)) {
      responseMap.set(r.party_member_event_id, new Map())
    }
    responseMap.get(r.party_member_event_id)!.set(r.question_id, r.answer)
  }

  // Build response structure
  const membersWithEvents = members.map(member => {
    const events = (memberEvents || [])
      .filter(me => me.party_member_id === member.id)
      .map(me => {
        const event = eventMap.get(me.event_id)
        const eventQuestions = (questions || [])
          .filter(q => q.event_id === me.event_id)
          .filter(q => q.applies_to === 'all' || (q.applies_to === 'accepted_only' && me.rsvp_status === 'accepted'))
          .map(q => ({
            id: q.id,
            question_text: q.question_text,
            question_type: q.question_type,
            options: q.options,
            is_required: q.is_required,
            current_answer: responseMap.get(me.id)?.get(q.id) ?? null,
          }))

        return {
          member_event_id: me.id,
          event_id: me.event_id,
          event_title: event?.event_title || '',
          event_start: event?.event_start || null,
          event_end: event?.event_end || null,
          event_location: event?.event_location || null,
          rsvp_status: me.rsvp_status,
          rsvp_deadline: me.rsvp_deadline,
          rsvp_responded_at: me.rsvp_responded_at,
          questions: eventQuestions,
        }
      })

    return {
      id: member.id,
      first_name: member.first_name,
      last_name: member.last_name,
      is_lead_booker: member.is_lead_booker,
      is_plus_one: member.is_plus_one,
      events,
    }
  })

  // Mark as opened on first load
  if (party.status === 'sent') {
    await supabase
      .from('invite_parties')
      .update({ status: 'opened', opened_at: new Date().toISOString() })
      .eq('id', party.id)
  }

  return jsonResponse({
    party: {
      id: party.id,
      name: party.name,
      status: party.status === 'sent' ? 'opened' : party.status,
      max_plus_ones: party.max_plus_ones,
      plus_ones_added: party.plus_ones_added,
      version: party.version,
    },
    members: membersWithEvents,
  })
}

// ---------- Submit Action ----------

interface SubmitResponse {
  member_event_id: string
  rsvp_status: 'accepted' | 'declined'
  answers?: { question_id: string; answer: unknown }[]
}

interface NewPlusOne {
  first_name?: string
  last_name?: string
  event_ids: string[]
  rsvp_statuses: Record<string, string>
  answers?: { event_id: string; question_id: string; answer: unknown }[]
}

async function handleSubmit(token: string, body: Record<string, unknown>) {
  const party = await resolveParty(token)

  if (!party) {
    return jsonResponse({ error: 'INVITE_NOT_FOUND', message: 'This invite link is not valid.' }, 404)
  }

  if (party.status === 'cancelled') {
    return jsonResponse({ error: 'INVITE_CANCELLED', message: 'This invite has been cancelled.' }, 403)
  }

  if (!await checkRateLimit(party.id, 'submit')) {
    return jsonResponse({ error: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' }, 429)
  }

  // Optimistic locking
  const clientVersion = body.version as number
  if (clientVersion && clientVersion !== party.version) {
    return jsonResponse({
      error: 'VERSION_CONFLICT',
      message: 'This RSVP has been updated since you loaded it. Please reload and try again.',
    }, 409)
  }

  const responses = (body.responses || []) as SubmitResponse[]
  const newPlusOnes = (body.new_plus_ones || []) as NewPlusOne[]

  // Validate member_event_ids belong to this party
  const { data: validMemberEvents } = await supabase
    .from('invite_party_member_events')
    .select('id, party_member_id, event_id, rsvp_deadline')
    .in('party_member_id',
      (await supabase
        .from('invite_party_members')
        .select('id')
        .eq('party_id', party.id)
      ).data?.map(m => m.id) || []
    )

  const validIds = new Set((validMemberEvents || []).map(me => me.id))
  const memberEventMap = new Map((validMemberEvents || []).map(me => [me.id, me]))

  // Check all submitted member_event_ids are valid (IDOR prevention)
  const invalidIds = responses.filter(r => !validIds.has(r.member_event_id))
  if (invalidIds.length > 0) {
    return jsonResponse({
      error: 'INVALID_REFERENCE',
      message: 'One or more member_event_ids do not belong to this party.',
    }, 400)
  }

  // Check deadlines
  const lockedEvents: string[] = []
  for (const r of responses) {
    const me = memberEventMap.get(r.member_event_id)
    if (me?.rsvp_deadline && new Date(me.rsvp_deadline) < new Date()) {
      lockedEvents.push(me.event_id)
    }
  }
  if (lockedEvents.length > 0) {
    return jsonResponse({
      error: 'DEADLINE_PASSED',
      message: 'The RSVP deadline has passed for one or more events.',
      locked_events: lockedEvents,
    }, 400)
  }

  // Validate required questions
  const eventIds = [...new Set((validMemberEvents || []).map(me => me.event_id))]
  const { data: allQuestions } = await supabase
    .from('invite_questions')
    .select('id, event_id, is_required, applies_to')
    .in('event_id', eventIds)
    .eq('is_required', true)

  const validationErrors: { member_event_id: string; question_id: string; error: string }[] = []

  for (const r of responses) {
    if (r.rsvp_status !== 'accepted') continue
    const me = memberEventMap.get(r.member_event_id)
    if (!me) continue

    const requiredQuestions = (allQuestions || []).filter(q =>
      q.event_id === me.event_id && (q.applies_to === 'all' || q.applies_to === 'accepted_only')
    )

    const answeredIds = new Set((r.answers || []).map(a => a.question_id))
    for (const q of requiredQuestions) {
      if (!answeredIds.has(q.id)) {
        validationErrors.push({
          member_event_id: r.member_event_id,
          question_id: q.id,
          error: 'Required question not answered',
        })
      }
    }
  }

  if (validationErrors.length > 0) {
    return jsonResponse({
      error: 'VALIDATION_ERROR',
      message: 'Some required questions were not answered.',
      fields: validationErrors,
    }, 400)
  }

  // Check plus-one limits
  if (newPlusOnes.length > 0) {
    const remaining = party.max_plus_ones - party.plus_ones_added
    if (newPlusOnes.length > remaining) {
      return jsonResponse({
        error: 'PLUS_ONE_LIMIT',
        message: `Maximum of ${party.max_plus_ones} plus-ones allowed. You have ${party.plus_ones_added} already added.`,
      }, 400)
    }
  }

  // --- Apply changes ---

  let acceptedCount = 0
  let declinedCount = 0

  // Update existing member-event RSVPs
  for (const r of responses) {
    const { error } = await supabase
      .from('invite_party_member_events')
      .update({
        rsvp_status: r.rsvp_status,
        rsvp_responded_at: new Date().toISOString(),
      })
      .eq('id', r.member_event_id)

    if (error) {
      console.error('Error updating RSVP:', error)
      continue
    }

    if (r.rsvp_status === 'accepted') acceptedCount++
    else if (r.rsvp_status === 'declined') declinedCount++

    // Upsert answers
    for (const answer of r.answers || []) {
      await supabase
        .from('invite_responses')
        .upsert({
          party_member_event_id: r.member_event_id,
          question_id: answer.question_id,
          answer: answer.answer,
        }, { onConflict: 'party_member_event_id,question_id' })
    }

    // Create registration for accepted members
    if (r.rsvp_status === 'accepted') {
      const me = memberEventMap.get(r.member_event_id)
      if (me) {
        const { data: member } = await supabase
          .from('invite_party_members')
          .select('person_id')
          .eq('id', me.party_member_id)
          .single()

        if (member?.person_id) {
          // Check if registration already exists
          const { data: existingReg } = await supabase
            .from('events_registrations')
            .select('id')
            .eq('event_id', me.event_id)
            .eq('person_id', member.person_id)
            .maybeSingle()

          if (!existingReg) {
            const { data: reg } = await supabase
              .from('events_registrations')
              .insert({
                event_id: me.event_id,
                person_id: member.person_id,
                registration_type: 'free',
                registration_source: 'invite',
                status: 'confirmed',
                registration_metadata: { party_id: party.id },
              })
              .select('id')
              .single()

            if (reg) {
              await supabase
                .from('invite_party_member_events')
                .update({ registration_id: reg.id })
                .eq('id', r.member_event_id)
            }
          }
        }
      }
    }
  }

  // Create new plus-ones
  let plusOnesAdded = 0
  for (const plusOne of newPlusOnes) {
    const { data: newMember } = await supabase
      .from('invite_party_members')
      .insert({
        party_id: party.id,
        first_name: plusOne.first_name || null,
        last_name: plusOne.last_name || null,
        is_lead_booker: false,
        is_plus_one: true,
        sort_order: 100 + plusOnesAdded,
      })
      .select('id')
      .single()

    if (!newMember) continue
    plusOnesAdded++

    for (const eventId of plusOne.event_ids) {
      const rsvpStatus = plusOne.rsvp_statuses?.[eventId] || 'accepted'

      const { data: newMemberEvent } = await supabase
        .from('invite_party_member_events')
        .insert({
          party_member_id: newMember.id,
          event_id: eventId,
          rsvp_status: rsvpStatus,
          rsvp_responded_at: new Date().toISOString(),
        })
        .select('id')
        .single()

      if (newMemberEvent && plusOne.answers) {
        for (const answer of plusOne.answers) {
          if (answer.event_id === eventId) {
            await supabase.from('invite_responses').insert({
              party_member_event_id: newMemberEvent.id,
              question_id: answer.question_id,
              answer: answer.answer,
            })
          }
        }
      }

      if (rsvpStatus === 'accepted') acceptedCount++
    }
  }

  // Update party status and version
  const allMemberEvents = await supabase
    .from('invite_party_member_events')
    .select('rsvp_status')
    .in('party_member_id',
      (await supabase.from('invite_party_members').select('id').eq('party_id', party.id)).data?.map(m => m.id) || []
    )

  const allStatuses = (allMemberEvents.data || []).map(me => me.rsvp_status)
  const allResponded = allStatuses.every(s => s !== 'pending')
  const someResponded = allStatuses.some(s => s !== 'pending')

  const newPartyStatus = allResponded ? 'responded' : someResponded ? 'partially_responded' : party.status

  await supabase
    .from('invite_parties')
    .update({
      status: newPartyStatus,
      responded_at: new Date().toISOString(),
      plus_ones_added: party.plus_ones_added + plusOnesAdded,
      version: party.version + 1,
    })
    .eq('id', party.id)

  return jsonResponse({
    success: true,
    version: party.version + 1,
    summary: {
      accepted: acceptedCount,
      declined: declinedCount,
      plus_ones_added: plusOnesAdded,
    },
  })
}

// ---------- Track Action ----------

async function handleTrack(token: string, interactionType: string, req: Request) {
  const party = await resolveParty(token)
  if (!party) return jsonResponse({ success: true }) // silent fail for tracking

  const userAgent = req.headers.get('user-agent') || ''
  const forwardedFor = req.headers.get('x-forwarded-for')
  const ipAddress = forwardedFor ? forwardedFor.split(',')[0].trim() : null

  await supabase.from('event_invite_interactions').insert({
    party_id: party.id,
    interaction_type: interactionType || 'opened',
    ip_address: ipAddress,
    user_agent: userAgent,
  })

  return jsonResponse({ success: true })
}

// ---------- Open Link Self-Serve ----------
//
// Open links are shareable URLs (e.g. /o/abc123) that let anyone with the
// link create their own party and RSVP. Unlike the standard token-based
// flow, there's no pre-existing party — the guest provides their name and
// (optionally) party members, then submits.

async function resolveOpenLink(code: string) {
  const { data, error } = await supabase
    .from('invite_open_links')
    .select('id, event_id, sub_event_id, short_code, label, is_active, max_members_per_party, expires_at')
    .eq('short_code', code)
    .maybeSingle()
  if (error || !data) return null
  return data
}

async function handleOpenLinkLoad(code: string) {
  const link = await resolveOpenLink(code)
  if (!link) {
    return jsonResponse({ error: 'LINK_NOT_FOUND', message: 'This link is not valid.' }, 404)
  }
  if (!link.is_active) {
    return jsonResponse({ error: 'LINK_DISABLED', message: 'This link has been disabled.' }, 403)
  }
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    return jsonResponse({ error: 'LINK_EXPIRED', message: 'This link has expired.' }, 403)
  }

  // Load event
  const { data: event } = await supabase
    .from('events')
    .select('id, event_title, event_start, event_end, event_location')
    .eq('id', link.event_id)
    .single()

  if (!event) {
    return jsonResponse({ error: 'EVENT_NOT_FOUND', message: 'Event no longer available.' }, 404)
  }

  // Load sub-events. If the link is scoped to a specific sub-event, only
  // return that one; otherwise return all for the event.
  let subEventQuery = supabase
    .from('invite_sub_events')
    .select('id, name, description, starts_at, ends_at, rsvp_deadline, sort_order')
    .eq('event_id', link.event_id)
    .order('sort_order')
  if (link.sub_event_id) {
    subEventQuery = subEventQuery.eq('id', link.sub_event_id)
  }
  const { data: subEvents } = await subEventQuery

  // Load applicable questions — scoped to the event and (optionally) the
  // single sub-event when the link is locked to one.
  let questionQuery = supabase
    .from('invite_questions')
    .select('id, sub_event_id, question_text, question_type, options, is_required, applies_to, sort_order')
    .eq('event_id', link.event_id)
    .order('sort_order')
  const { data: questions } = await questionQuery

  return jsonResponse({
    link: {
      id: link.id,
      short_code: link.short_code,
      label: link.label,
      sub_event_id: link.sub_event_id,
      max_members_per_party: link.max_members_per_party,
    },
    event: {
      id: event.id,
      title: event.event_title,
      starts_at: event.event_start,
      ends_at: event.event_end,
      location: event.event_location,
    },
    sub_events: (subEvents || []).map(se => ({
      id: se.id,
      name: se.name,
      description: se.description,
      starts_at: se.starts_at,
      ends_at: se.ends_at,
      rsvp_deadline: se.rsvp_deadline,
    })),
    questions: (questions || []).map(q => ({
      id: q.id,
      sub_event_id: q.sub_event_id,
      question_text: q.question_text,
      question_type: q.question_type,
      options: q.options,
      is_required: q.is_required,
      applies_to: q.applies_to,
    })),
  })
}

interface OpenSubmitMember {
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  // One rsvp decision per sub-event the guest is responding to
  rsvps: Array<{ sub_event_id: string | null; status: string }>
  // Answers to follow-up questions, keyed by question_id
  answers?: Array<{ sub_event_id: string | null; question_id: string; answer: unknown }>
}

interface OpenSubmitBody {
  code: string
  party_name?: string
  members: OpenSubmitMember[]
}

const BASE36 = 'abcdefghijklmnopqrstuvwxyz0123456789'

function generateShortCode(): string {
  const array = new Uint8Array(6)
  crypto.getRandomValues(array)
  return Array.from(array, (b: number) => BASE36[b % 36]).join('')
}

function generateToken(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return Array.from(array, (b: number) => b.toString(16).padStart(2, '0')).join('')
}

async function handleOpenLinkSubmit(body: OpenSubmitBody) {
  const { code, party_name, members } = body
  if (!code) return jsonResponse({ error: 'VALIDATION_ERROR', message: 'code is required' }, 400)
  if (!Array.isArray(members) || members.length === 0) {
    return jsonResponse({ error: 'VALIDATION_ERROR', message: 'At least one member is required' }, 400)
  }

  const link = await resolveOpenLink(code)
  if (!link) {
    return jsonResponse({ error: 'LINK_NOT_FOUND', message: 'This link is not valid.' }, 404)
  }
  if (!link.is_active) {
    return jsonResponse({ error: 'LINK_DISABLED', message: 'This link has been disabled.' }, 403)
  }
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    return jsonResponse({ error: 'LINK_EXPIRED', message: 'This link has expired.' }, 403)
  }
  if (members.length > (link.max_members_per_party || 10)) {
    return jsonResponse({
      error: 'TOO_MANY_MEMBERS',
      message: `Parties are limited to ${link.max_members_per_party} members on this link.`,
    }, 400)
  }
  // Validate every member has a name
  for (const m of members) {
    if (!m.first_name?.trim() && !m.last_name?.trim()) {
      return jsonResponse({ error: 'VALIDATION_ERROR', message: 'Every member must have a name' }, 400)
    }
    if (!Array.isArray(m.rsvps) || m.rsvps.length === 0) {
      return jsonResponse({ error: 'VALIDATION_ERROR', message: 'Every member must RSVP to at least one event' }, 400)
    }
    for (const r of m.rsvps) {
      if (!['accepted', 'declined'].includes(r.status)) {
        return jsonResponse({ error: 'VALIDATION_ERROR', message: `Invalid rsvp status: ${r.status}` }, 400)
      }
    }
  }

  // Generate unique party short code (retry on collision)
  let partyShortCode = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    partyShortCode = generateShortCode()
    const { data: collision } = await supabase
      .from('invite_parties')
      .select('id')
      .eq('short_code', partyShortCode)
      .maybeSingle()
    if (!collision) break
    if (attempt === 2) {
      return jsonResponse({ error: 'INTERNAL_ERROR', message: 'Failed to generate unique code' }, 500)
    }
  }

  // Derive party name from the lead booker if not provided
  const leadName = members[0]
  const fallbackName = [leadName.first_name, leadName.last_name].filter(Boolean).join(' ') || 'Guest party'

  // Create party
  const { data: party, error: partyErr } = await supabase
    .from('invite_parties')
    .insert({
      name: party_name?.trim() || fallbackName,
      token: generateToken(),
      short_code: partyShortCode,
      status: 'responded',
      responded_at: new Date().toISOString(),
      open_link_id: link.id,
    })
    .select('id, short_code')
    .single()

  if (partyErr || !party) {
    console.error('Failed to create party:', partyErr)
    return jsonResponse({ error: 'INTERNAL_ERROR', message: 'Failed to create party' }, 500)
  }

  // Create members + member-event mappings + responses
  for (let i = 0; i < members.length; i++) {
    const member = members[i]
    const { data: partyMember, error: memberErr } = await supabase
      .from('invite_party_members')
      .insert({
        party_id: party.id,
        first_name: member.first_name?.trim() || null,
        last_name: member.last_name?.trim() || null,
        email: member.email?.toLowerCase().trim() || null,
        phone: member.phone?.trim() || null,
        is_lead_booker: i === 0,
        sort_order: i,
      })
      .select('id')
      .single()

    if (memberErr || !partyMember) {
      console.error('Failed to create member:', memberErr)
      continue
    }

    // Create member-event mappings (one per rsvp)
    const memberEventIdsBySubEvent = new Map<string, string>()
    const nowIso = new Date().toISOString()
    for (const rsvp of member.rsvps) {
      const { data: me, error: meErr } = await supabase
        .from('invite_party_member_events')
        .insert({
          party_member_id: partyMember.id,
          event_id: link.event_id,
          sub_event_id: rsvp.sub_event_id,
          rsvp_status: rsvp.status,
          rsvp_responded_at: nowIso,
        })
        .select('id')
        .single()
      if (meErr || !me) {
        console.error('Failed to create member-event:', meErr)
        continue
      }
      memberEventIdsBySubEvent.set(rsvp.sub_event_id || '__event__', me.id)
    }

    // Insert follow-up responses
    if (member.answers && member.answers.length > 0) {
      const responseRows = member.answers
        .map(a => {
          const memberEventId = memberEventIdsBySubEvent.get(a.sub_event_id || '__event__')
          if (!memberEventId) return null
          return {
            party_member_event_id: memberEventId,
            question_id: a.question_id,
            answer: a.answer,
          }
        })
        .filter(Boolean) as Array<{ party_member_event_id: string; question_id: string; answer: unknown }>

      if (responseRows.length > 0) {
        const { error: responseErr } = await supabase
          .from('invite_responses')
          .upsert(responseRows, { onConflict: 'party_member_event_id,question_id' })
        if (responseErr) {
          console.error('Failed to insert responses:', responseErr)
        }
      }
    }
  }

  // Bump the link's usage stats (read-then-update; not atomic but good
  // enough for low-contention self-serve submissions)
  const { data: currentLink } = await supabase
    .from('invite_open_links')
    .select('times_used')
    .eq('id', link.id)
    .single()
  await supabase
    .from('invite_open_links')
    .update({
      times_used: ((currentLink?.times_used || 0) + 1),
      last_used_at: new Date().toISOString(),
    })
    .eq('id', link.id)

  return jsonResponse({
    success: true,
    party: {
      id: party.id,
      short_code: party.short_code,
    },
  })
}

// ---------- Main Handler ----------

export default async function (req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' }, 405)
  }

  try {
    const body = await req.json()
    const { action, token } = body

    // Open-link flow doesn't need a token — it uses a short code instead.
    if (action === 'open-link-load') {
      if (!body.code) return jsonResponse({ error: 'VALIDATION_ERROR', message: 'code is required' }, 400)
      return await handleOpenLinkLoad(body.code)
    }
    if (action === 'open-link-submit') {
      return await handleOpenLinkSubmit(body)
    }

    if (!token) {
      return jsonResponse({ error: 'VALIDATION_ERROR', message: 'Token is required' }, 400)
    }

    switch (action) {
      case 'load':
        return await handleLoad(token)

      case 'submit':
        return await handleSubmit(token, body)

      case 'track':
        return await handleTrack(token, body.interaction_type, req)

      default:
        return jsonResponse({ error: 'INVALID_ACTION', message: `Unknown action: ${action}` }, 400)
    }
  } catch (error) {
    console.error('Error processing RSVP request:', error)
    return jsonResponse({ error: 'INTERNAL_ERROR', message: 'Internal server error' }, 500)
  }
}
