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

// ---------- Helpers ----------

const BASE36 = 'abcdefghijklmnopqrstuvwxyz0123456789'

function generateShortCode(): string {
  const array = new Uint8Array(6)
  crypto.getRandomValues(array)
  return Array.from(array, b => BASE36[b % 36]).join('')
}

function generateToken(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('')
}

function generateQrCodeId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789' // no ambiguous chars
  const array = new Uint8Array(12)
  crypto.getRandomValues(array)
  return Array.from(array, b => chars[b % chars.length]).join('')
}

// ---------- Geocoding + driving route (lazy-cached on invite_parties) ----------
//
// Inlined here rather than imported from the events module so the edge
// function deploys as a single file.
//
// Endpoints are env-overridable so self-hosters can swap in their own
// Nominatim / OSRM instances:
//   NOMINATIM_BASE_URL  default https://nominatim.openstreetmap.org
//   OSRM_BASE_URL       default https://router.project-osrm.org

const NOMINATIM_BASE_URL = Deno.env.get('NOMINATIM_BASE_URL') || 'https://nominatim.openstreetmap.org'
const OSRM_BASE_URL = Deno.env.get('OSRM_BASE_URL') || 'https://router.project-osrm.org'
const GEOCODER_USER_AGENT = 'gatewaze-event-invites (https://github.com/gatewaze/gatewaze-modules)'

interface PartyGeocodeRow {
  id: string
  address: string | null
  address_lat: number | null
  address_lng: number | null
  drive_seconds_to_venue: number | null
  drive_distance_meters_to_venue: number | null
}

async function geocodeAddress(query: string): Promise<{ lat: number; lng: number } | null> {
  const trimmed = (query || '').trim()
  if (!trimmed) return null
  const params = new URLSearchParams({ format: 'json', limit: '1', q: trimmed })
  const url = `${NOMINATIM_BASE_URL.replace(/\/$/, '')}/search?${params.toString()}`
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': GEOCODER_USER_AGENT, Accept: 'application/json' },
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  const body = (await res.json()) as Array<{ lat: string; lon: string }>
  if (!Array.isArray(body) || body.length === 0) return null
  const lat = Number.parseFloat(body[0].lat)
  const lng = Number.parseFloat(body[0].lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return { lat, lng }
}

async function fetchDrivingRoute(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): Promise<{ distanceMeters: number; durationSeconds: number } | null> {
  // OSRM uses lon,lat order — easy to get backwards.
  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`
  const url = `${OSRM_BASE_URL.replace(/\/$/, '')}/route/v1/driving/${coords}?overview=false&alternatives=false&steps=false`
  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch {
    return null
  }
  if (!res.ok) return null
  const body = (await res.json()) as { code?: string; routes?: Array<{ distance: number; duration: number }> }
  if (body.code !== 'Ok' || !body.routes?.length) return null
  const route = body.routes[0]
  if (!Number.isFinite(route.distance) || !Number.isFinite(route.duration)) return null
  return { distanceMeters: route.distance, durationSeconds: route.duration }
}

/**
 * Ensure the party has cached lat/lng + driving route to the venue. Cached
 * values are reused when present; only missing pieces are looked up. Returns
 * null when distance can't be resolved (no address, no venue coords, or
 * upstream geocoder/router failure) — caller treats null as "skip the
 * distance template variables", the send still goes out.
 */
async function ensurePartyDistanceCached(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  party: PartyGeocodeRow,
  venue: { lat: number; lng: number } | null,
): Promise<{ distanceMeters: number; durationSeconds: number } | null> {
  if (!party.address) return null
  if (!venue) return null

  const updates: Record<string, unknown> = {}
  let lat = party.address_lat
  let lng = party.address_lng
  if (lat == null || lng == null) {
    const geocoded = await geocodeAddress(party.address)
    if (!geocoded) return null
    lat = geocoded.lat
    lng = geocoded.lng
    updates.address_lat = lat
    updates.address_lng = lng
    updates.address_geocoded_at = new Date().toISOString()
  }

  let distance = party.drive_distance_meters_to_venue
  let duration = party.drive_seconds_to_venue
  if (distance == null || duration == null) {
    const route = await fetchDrivingRoute({ lat, lng }, venue)
    if (!route) {
      // Persist the geocode even if routing failed — saves a Nominatim call
      // next time. Distance vars stay null this round.
      if (Object.keys(updates).length > 0) {
        await client.from('invite_parties').update(updates).eq('id', party.id)
      }
      return null
    }
    distance = Math.round(route.distanceMeters)
    duration = Math.round(route.durationSeconds)
    updates.drive_distance_meters_to_venue = distance
    updates.drive_seconds_to_venue = duration
    updates.drive_route_computed_at = new Date().toISOString()
  }

  if (Object.keys(updates).length > 0) {
    await client.from('invite_parties').update(updates).eq('id', party.id)
  }
  return { distanceMeters: distance!, durationSeconds: duration! }
}

/**
 * Format the cached values as user-facing strings for the email template.
 * Empty strings when distance is unavailable so the template renders cleanly
 * without "undefined" — caller can wrap in conditional template logic.
 */
function formatDistanceVars(
  result: { distanceMeters: number; durationSeconds: number } | null,
): { distance_to_venue: string; drive_time_to_venue: string } {
  if (!result) return { distance_to_venue: '', drive_time_to_venue: '' }
  const miles = result.distanceMeters / 1609.344
  const distanceLabel =
    miles < 0.1
      ? `${Math.round(result.distanceMeters * 1.0936)} yd`
      : `${miles.toFixed(miles < 10 ? 1 : 0)} mi`
  const mins = Math.round(result.durationSeconds / 60)
  let timeLabel: string
  if (mins < 1) timeLabel = '< 1 min'
  else if (mins < 60) timeLabel = `${mins} min`
  else {
    const hrs = Math.floor(mins / 60)
    const rem = mins % 60
    timeLabel = rem === 0 ? `${hrs} hr` : `${hrs} hr ${rem} min`
  }
  return { distance_to_venue: distanceLabel, drive_time_to_venue: timeLabel }
}

// ---------- People Management ----------

interface PersonInput {
  email: string
  first_name?: string
  last_name?: string
  phone?: string
  company?: string
  job_title?: string
}

async function findOrCreatePerson(input: PersonInput): Promise<{ person_id: string; profile_id: string | null; created: boolean }> {
  // Look up existing person by email
  const { data: existing } = await supabase
    .from('people')
    .select('id')
    .eq('email', input.email.toLowerCase().trim())
    .maybeSingle()

  if (existing) {
    // Check for existing profile
    const { data: profile } = await supabase
      .from('people_profiles')
      .select('id')
      .eq('person_id', existing.id)
      .maybeSingle()

    return { person_id: existing.id, profile_id: profile?.id || null, created: false }
  }

  // Create new person
  const attributes: Record<string, unknown> = {}
  if (input.first_name) attributes.first_name = input.first_name
  if (input.last_name) attributes.last_name = input.last_name
  if (input.company) attributes.company = input.company
  if (input.job_title) attributes.job_title = input.job_title

  const { data: person, error: personErr } = await supabase
    .from('people')
    .insert({
      email: input.email.toLowerCase().trim(),
      phone: input.phone || null,
      attributes,
      is_guest: true,
    })
    .select('id')
    .single()

  if (personErr || !person) {
    throw new Error(`Failed to create person: ${JSON.stringify(personErr)}`)
  }

  // Create people_profile
  const { data: profile, error: profileErr } = await supabase
    .from('people_profiles')
    .insert({
      person_id: person.id,
      qr_code_id: generateQrCodeId(),
    })
    .select('id')
    .single()

  if (profileErr) {
    console.warn(`Warning: Failed to create profile for ${input.email}:`, profileErr)
  }

  return { person_id: person.id, profile_id: profile?.id || null, created: true }
}

// ---------- Party Creation ----------

interface MemberInput {
  person_id?: string | null
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  is_lead_booker?: boolean
  event_ids: string[]
  rsvp_deadline?: string | null
}

interface CreatePartyInput {
  name: string
  max_plus_ones?: number
  delivery_channel?: string
  notes?: string
  members: MemberInput[]
  batch_id?: string | null
}

async function createParty(input: CreatePartyInput): Promise<Record<string, unknown>> {
  const token = generateToken()

  // Generate short code with collision retry
  let shortCode = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    shortCode = generateShortCode()
    const { data: collision } = await supabase
      .from('invite_parties')
      .select('id')
      .eq('short_code', shortCode)
      .maybeSingle()
    if (!collision) break
    if (attempt === 2) throw new Error('Failed to generate unique short code after 3 attempts')
  }

  // Create the party
  const { data: party, error: partyErr } = await supabase
    .from('invite_parties')
    .insert({
      name: input.name,
      token,
      short_code: shortCode,
      max_plus_ones: input.max_plus_ones || 0,
      delivery_channel: input.delivery_channel || 'email',
      notes: input.notes || null,
      batch_id: input.batch_id || null,
    })
    .select('id, short_code, token')
    .single()

  if (partyErr || !party) {
    throw new Error(`Failed to create party: ${JSON.stringify(partyErr)}`)
  }

  const peopleCreated: string[] = []

  // Create members
  for (let i = 0; i < input.members.length; i++) {
    const member = input.members[i]
    let personId = member.person_id || null

    // If no person_id but has email, find or create person
    if (!personId && member.email) {
      const result = await findOrCreatePerson({
        email: member.email,
        first_name: member.first_name,
        last_name: member.last_name,
        phone: member.phone,
      })
      personId = result.person_id
      if (result.created) peopleCreated.push(member.email)

      // If name wasn't provided, try to get it from the person record
      if (!member.first_name && !member.last_name) {
        const { data: person } = await supabase
          .from('people')
          .select('attributes')
          .eq('id', personId)
          .single()
        if (person?.attributes) {
          member.first_name = (person.attributes as Record<string, string>).first_name || undefined
          member.last_name = (person.attributes as Record<string, string>).last_name || undefined
        }
      }
    }

    const { data: partyMember, error: memberErr } = await supabase
      .from('invite_party_members')
      .insert({
        party_id: party.id,
        person_id: personId,
        first_name: member.first_name || null,
        last_name: member.last_name || null,
        email: member.email?.toLowerCase().trim() || null,
        phone: member.phone || null,
        is_lead_booker: member.is_lead_booker ?? (i === 0),
        sort_order: i,
      })
      .select('id')
      .single()

    if (memberErr || !partyMember) {
      throw new Error(`Failed to create party member: ${JSON.stringify(memberErr)}`)
    }

    // Create member-event mappings
    for (const eventId of member.event_ids) {
      const { error: eventErr } = await supabase
        .from('invite_party_member_events')
        .insert({
          party_member_id: partyMember.id,
          event_id: eventId,
          rsvp_deadline: member.rsvp_deadline || null,
        })

      if (eventErr) {
        throw new Error(`Failed to create member-event mapping: ${JSON.stringify(eventErr)}`)
      }
    }
  }

  const portalUrl = Deno.env.get('PORTAL_URL') || Deno.env.get('VITE_PORTAL_URL') || ''

  return {
    party: {
      id: party.id,
      short_code: party.short_code,
      token: party.token,
      rsvp_url: portalUrl ? `${portalUrl}/rsvp/${party.short_code}` : `/rsvp/${party.short_code}`,
      member_count: input.members.length,
    },
    people_created: peopleCreated,
  }
}

// ---------- CSV Import ----------

interface CsvRow {
  party_name?: string
  first_name?: string
  last_name?: string
  email: string
  phone?: string
  company?: string
  job_title?: string
  events?: string[]
}

interface ImportCsvInput {
  event_ids: string[]
  rows: CsvRow[]
  event_mapping?: Record<string, string>
  delivery_channel?: string
  default_rsvp_deadline?: string | null
}

async function importCsv(input: ImportCsvInput): Promise<Record<string, unknown>> {
  const { rows, event_ids, event_mapping, delivery_channel, default_rsvp_deadline } = input

  // Group rows by party_name
  const partyGroups = new Map<string, CsvRow[]>()
  for (const row of rows) {
    if (!row.email) continue
    const groupKey = row.party_name || row.email // individual party if no party_name
    const group = partyGroups.get(groupKey) || []
    group.push(row)
    partyGroups.set(groupKey, group)
  }

  let partiesCreated = 0
  let membersCreated = 0
  let peopleCreated = 0
  const skipped: { row: number; reason: string }[] = []
  const errors: { row: number; reason: string }[] = []

  let rowIndex = 0
  for (const [partyName, groupRows] of partyGroups) {
    try {
      const members: MemberInput[] = groupRows.map((row, i) => {
        // Resolve event IDs from event_mapping or use all event_ids
        let memberEventIds: string[]
        if (row.events && event_mapping) {
          memberEventIds = row.events
            .map(e => event_mapping[e.trim()])
            .filter(Boolean) as string[]
        } else {
          memberEventIds = event_ids
        }

        return {
          first_name: row.first_name,
          last_name: row.last_name,
          email: row.email,
          phone: row.phone,
          is_lead_booker: i === 0,
          event_ids: memberEventIds,
          rsvp_deadline: default_rsvp_deadline || null,
        }
      })

      const result = await createParty({
        name: partyName,
        delivery_channel: delivery_channel || 'email',
        members,
      })

      partiesCreated++
      membersCreated += members.length
      peopleCreated += ((result.people_created as string[]) || []).length
    } catch (err) {
      errors.push({ row: rowIndex, reason: String(err) })
    }
    rowIndex++
  }

  return {
    success: true,
    parties_created: partiesCreated,
    members_created: membersCreated,
    people_created: peopleCreated,
    skipped,
    errors,
  }
}

// ---------- Send Invites ----------

interface SendInput {
  party_ids: string[]
  template_id?: string
}

async function sendInvites(input: SendInput): Promise<Record<string, unknown>> {
  const { party_ids, template_id } = input
  let sent = 0
  let failed = 0
  const sendErrors: { party_id: string; reason: string }[] = []

  for (const partyId of party_ids) {
    try {
      // Get party with lead booker info
      const { data: party } = await supabase
        .from('invite_parties')
        .select('id, name, short_code, token, delivery_channel, status')
        .eq('id', partyId)
        .single()

      if (!party || (party.status !== 'draft' && party.status !== 'send_failed')) {
        sendErrors.push({ party_id: partyId, reason: `Party not in sendable state (${party?.status})` })
        failed++
        continue
      }

      // Get lead booker
      const { data: leadBooker } = await supabase
        .from('invite_party_members')
        .select('first_name, last_name, email, phone')
        .eq('party_id', partyId)
        .eq('is_lead_booker', true)
        .single()

      if (!leadBooker?.email && party.delivery_channel === 'email') {
        sendErrors.push({ party_id: partyId, reason: 'Lead booker has no email' })
        await supabase.from('invite_parties').update({ status: 'send_failed' }).eq('id', partyId)
        failed++
        continue
      }

      // Get all member names for template
      const { data: members } = await supabase
        .from('invite_party_members')
        .select('first_name, last_name')
        .eq('party_id', partyId)
        .order('sort_order')

      const memberNames = (members || [])
        .map(m => [m.first_name, m.last_name].filter(Boolean).join(' '))
        .filter(Boolean)
        .join(', ')

      // Get event details for first event
      const { data: firstEvent } = await supabase
        .from('invite_party_member_events')
        .select('event_id, events!inner(event_title, event_start, event_location)')
        .eq('party_member_id', (await supabase
          .from('invite_party_members')
          .select('id')
          .eq('party_id', partyId)
          .eq('is_lead_booker', true)
          .single()).data?.id || '')
        .limit(1)
        .maybeSingle()

      const portalUrl = Deno.env.get('PORTAL_URL') || Deno.env.get('VITE_PORTAL_URL') || ''
      const rsvpLink = `${portalUrl}/rsvp/${party.short_code}`

      if (party.delivery_channel === 'email') {
        // Create email batch job
        const eventData = (firstEvent as Record<string, unknown>)?.events as Record<string, unknown> | undefined

        const { error: jobErr } = await supabase
          .from('email_batch_jobs')
          .insert({
            event_id: (firstEvent as Record<string, unknown>)?.event_id || null,
            email_type: 'invite',
            template_id: template_id || null,
            subject_template: `You're invited: ${eventData?.event_title || 'Event'}`,
            from_email: null, // use default from bulk-emailing config
            status: 'pending',
            total_recipients: 1,
            // Store template variables in errors field (repurposed as metadata)
            errors: [{
              type: 'template_vars',
              to_email: leadBooker.email,
              variables: {
                party_name: party.name,
                lead_first_name: leadBooker.first_name || '',
                lead_last_name: leadBooker.last_name || '',
                rsvp_link: rsvpLink,
                event_title: eventData?.event_title || '',
                event_date: eventData?.event_start || '',
                event_location: eventData?.event_location || '',
                member_names: memberNames,
              },
            }],
          })

        if (jobErr) {
          sendErrors.push({ party_id: partyId, reason: `Failed to create email job: ${JSON.stringify(jobErr)}` })
          await supabase.from('invite_parties').update({ status: 'send_failed' }).eq('id', partyId)
          failed++
          continue
        }
      }
      // SMS and WhatsApp would be handled here when those modules are implemented

      // Update party status
      await supabase
        .from('invite_parties')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', partyId)

      sent++
    } catch (err) {
      sendErrors.push({ party_id: partyId, reason: String(err) })
      await supabase.from('invite_parties').update({ status: 'send_failed' }).eq('id', partyId)
      failed++
    }
  }

  return { success: true, sent, failed, errors: sendErrors }
}

// ---------- Send Channel (template-based multi-channel delivery) ----------

interface SendChannelInput {
  channel: string
  party_ids: string[]
  event_id: string
}

async function sendChannel(input: SendChannelInput): Promise<Record<string, unknown>> {
  const { channel, party_ids, event_id } = input
  let sent = 0
  let skipped = 0
  let failed = 0
  const skippedReasons: { party_id: string; reason: string }[] = []
  const errors: { party_id: string; reason: string }[] = []

  for (const partyId of party_ids) {
    try {
      // Get party info — includes the geocode cache so the send flow can
      // populate {distance_to_venue} + {drive_time_to_venue} template vars
      // without re-hitting Nominatim on every reminder dispatch.
      const { data: party } = await supabase
        .from('invite_parties')
        .select('id, name, short_code, status, address, address_lat, address_lng, drive_seconds_to_venue, drive_distance_meters_to_venue')
        .eq('id', partyId)
        .single()

      if (!party) {
        skippedReasons.push({ party_id: partyId, reason: 'Party not found' })
        skipped++
        continue
      }

      // Get party's sub-event assignments
      const { data: members } = await supabase
        .from('invite_party_members')
        .select('id')
        .eq('party_id', partyId)

      const { data: memberEvents } = await supabase
        .from('invite_party_member_events')
        .select('sub_event_id')
        .in('party_member_id', (members || []).map(m => m.id))
        .not('sub_event_id', 'is', null)

      const subEventIds = [...new Set((memberEvents || []).map(me => me.sub_event_id).filter(Boolean))]

      // Get primary sub-event (first by sort_order)
      let primarySubEventId: string | null = null
      if (subEventIds.length > 0) {
        const { data: subEvents } = await supabase
          .from('invite_sub_events')
          .select('id')
          .in('id', subEventIds)
          .order('sort_order')
          .limit(1)
        primarySubEventId = subEvents?.[0]?.id || null
      }

      // Find matching template
      let template = null
      if (primarySubEventId) {
        const { data } = await supabase
          .from('invite_templates')
          .select('*')
          .eq('event_id', event_id)
          .eq('sub_event_id', primarySubEventId)
          .eq('channel', channel)
          .eq('is_active', true)
          .single()
        template = data
      }
      if (!template) {
        const { data } = await supabase
          .from('invite_templates')
          .select('*')
          .eq('event_id', event_id)
          .is('sub_event_id', null)
          .eq('channel', channel)
          .eq('is_active', true)
          .single()
        template = data
      }

      if (!template) {
        skippedReasons.push({ party_id: partyId, reason: `No ${channel} template found` })
        skipped++
        continue
      }

      // Get lead booker
      const { data: leadBooker } = await supabase
        .from('invite_party_members')
        .select('first_name, last_name, email, phone')
        .eq('party_id', partyId)
        .eq('is_lead_booker', true)
        .single()

      // Channel-specific delivery
      if (channel === 'email') {
        if (!leadBooker?.email) {
          skippedReasons.push({ party_id: partyId, reason: 'Lead booker has no email' })
          skipped++
          continue
        }

        const portalUrl = Deno.env.get('PORTAL_URL') || ''
        const rsvpLink = `${portalUrl}/rsvp/${party.short_code}`

        // Get event details for template variables
        const { data: event } = await supabase
          .from('events')
          .select('event_title, event_start, event_location, event_latitude, event_longitude, venue_address')
          .eq('id', event_id)
          .single()

        // Compute (or read from cache) the driving distance + time from the
        // party's mailing address to the event venue. Best-effort: missing
        // address or venue coords ⇒ distance vars are empty strings, send
        // continues normally.
        const venueCoords =
          typeof event?.event_latitude === 'number' && typeof event?.event_longitude === 'number'
            ? { lat: event.event_latitude, lng: event.event_longitude }
            : null
        const distanceResult = await ensurePartyDistanceCached(supabase, party, venueCoords)
        const distanceVars = formatDistanceVars(distanceResult)

        const { error: jobErr } = await supabase
          .from('email_batch_jobs')
          .insert({
            event_id,
            email_type: 'invite',
            template_id: template.id,
            subject_template: template.subject || `You're invited: ${event?.event_title || 'Event'}`,
            status: 'pending',
            total_recipients: 1,
            errors: [{
              type: 'template_vars',
              to_email: leadBooker.email,
              variables: {
                // Flat keys preserved for backwards-compat with anything still
                // reading the legacy template_vars shape.
                party_name: party.name,
                lead_first_name: leadBooker.first_name || '',
                lead_last_name: leadBooker.last_name || '',
                rsvp_link: rsvpLink,
                event_title: event?.event_title || '',
                event_date: event?.event_start || '',
                event_location: event?.event_location || '',
                venue_address: event?.venue_address || '',
                // Scoped keys matching admin/utils/inviteVariables.ts
                // {{address.distance_to_venue}} / {{address.drive_time_to_venue}}.
                'address.distance_to_venue': distanceVars.distance_to_venue,
                'address.drive_time_to_venue': distanceVars.drive_time_to_venue,
              },
            }],
          })

        if (jobErr) {
          errors.push({ party_id: partyId, reason: `Email job failed: ${jobErr.message}` })
          failed++
          continue
        }
      } else if (channel === 'sms' || channel === 'whatsapp') {
        if (!leadBooker?.phone) {
          skippedReasons.push({ party_id: partyId, reason: `Lead booker has no phone number` })
          skipped++
          continue
        }
        // SMS/WhatsApp delivery would call the respective module's edge function
        // For now, log the delivery as pending
      }

      // Log delivery
      await supabase.from('invite_deliveries').insert({
        party_id: partyId,
        channel,
        template_id: template.id,
        status: channel === 'pdf' ? 'downloaded' : 'sent',
        sent_at: new Date().toISOString(),
      })

      // Update party status
      if (party.status === 'draft' || party.status === 'send_failed') {
        await supabase
          .from('invite_parties')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', partyId)
      }

      sent++
    } catch (err) {
      errors.push({ party_id: partyId, reason: String(err) })
      failed++
    }
  }

  return { success: true, sent, skipped, failed, skipped_reasons: skippedReasons, errors }
}

// ---------- Backfill Geocoding ----------
//
// One-shot pass that walks every party for an event with an address but no
// cached lat/lng (or a cached lat/lng but no drive route to the venue) and
// fills the cache. Used to warm the cache before the first invite send so
// the send itself isn't blocked on hundreds of serial Nominatim calls.
//
// Rate-limited to one Nominatim call per ~1.1 seconds, per OSM's usage
// policy. OSRM has no published rate limit but we throttle the same way to
// keep total wall-clock time predictable. A 200-party event takes ~7 min on
// the public endpoints; a self-hosted Nominatim runs flat-out.

interface BackfillInput {
  event_id: string
}

async function backfillGeocoding(input: BackfillInput): Promise<Record<string, unknown>> {
  const { event_id } = input

  // Fetch the venue coords once — same shape that sendChannel uses.
  const { data: event } = await supabase
    .from('events')
    .select('event_latitude, event_longitude')
    .eq('id', event_id)
    .single()
  const venueCoords =
    typeof event?.event_latitude === 'number' && typeof event?.event_longitude === 'number'
      ? { lat: event.event_latitude, lng: event.event_longitude }
      : null

  if (!venueCoords) {
    return {
      ok: false,
      reason: 'event_missing_coords',
      message: 'Event has no event_latitude / event_longitude — set those on the Venue tab first.',
    }
  }

  // Find parties for this event with an address but missing geocode OR
  // missing drive route. We walk through invite_party_member_events to
  // join party → event (since invite_parties has no event_id directly).
  const { data: members } = await supabase
    .from('invite_party_member_events')
    .select('party_member_id')
    .eq('event_id', event_id)
  const memberIds = [...new Set((members || []).map(m => m.party_member_id).filter(Boolean))]
  if (memberIds.length === 0) {
    return { ok: true, processed: 0, geocoded: 0, routed: 0, failed: 0, skipped: 0 }
  }
  const { data: partyLinks } = await supabase
    .from('invite_party_members')
    .select('party_id')
    .in('id', memberIds)
  const partyIds = [...new Set((partyLinks || []).map(p => p.party_id).filter(Boolean))]

  const { data: parties } = await supabase
    .from('invite_parties')
    .select('id, address, address_lat, address_lng, drive_seconds_to_venue, drive_distance_meters_to_venue')
    .in('id', partyIds)

  let processed = 0
  let geocoded = 0
  let routed = 0
  let failed = 0
  let skipped = 0

  for (const party of parties || []) {
    processed++
    if (!party.address) {
      skipped++
      continue
    }
    const hadCoords = party.address_lat != null && party.address_lng != null
    const hadRoute =
      party.drive_seconds_to_venue != null && party.drive_distance_meters_to_venue != null
    if (hadCoords && hadRoute) {
      skipped++
      continue
    }

    const result = await ensurePartyDistanceCached(supabase, party, venueCoords)
    if (!result) {
      failed++
    } else {
      if (!hadCoords) geocoded++
      if (!hadRoute) routed++
    }

    // Polite delay so we stay below Nominatim's 1 req/sec cap. Cheap when
    // backfill is small; bounds the worst case for large weddings.
    await new Promise((r) => setTimeout(r, 1100))
  }

  return { ok: true, processed, geocoded, routed, failed, skipped }
}

// ---------- Auth Verification ----------

async function verifyAuth(req: Request): Promise<boolean> {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return false

  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error } = await supabase.auth.getUser(token)
  return !error && !!user
}

// ---------- Main Handler ----------

export default async function (req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' }, 405)
  }

  // Verify authenticated user
  const isAuthed = await verifyAuth(req)
  if (!isAuthed) {
    return jsonResponse({ error: 'UNAUTHORIZED', message: 'Authentication required' }, 401)
  }

  try {
    const body = await req.json()
    const { action } = body

    switch (action) {
      case 'create-party': {
        if (!body.name || !body.members?.length) {
          return jsonResponse({ error: 'VALIDATION_ERROR', message: 'name and members are required' }, 400)
        }
        // Validate each member has email or person_id
        for (const member of body.members) {
          if (!member.email && !member.person_id) {
            return jsonResponse({ error: 'VALIDATION_ERROR', message: 'Each member must have email or person_id' }, 400)
          }
          if (!member.event_ids?.length) {
            return jsonResponse({ error: 'VALIDATION_ERROR', message: 'Each member must have at least one event_id' }, 400)
          }
        }
        const result = await createParty(body)
        return jsonResponse(result, 201)
      }

      case 'import-csv': {
        if (!body.rows?.length) {
          return jsonResponse({ error: 'VALIDATION_ERROR', message: 'rows array is required' }, 400)
        }
        if (!body.event_ids?.length) {
          return jsonResponse({ error: 'VALIDATION_ERROR', message: 'event_ids array is required' }, 400)
        }
        const result = await importCsv(body)
        return jsonResponse(result)
      }

      case 'send': {
        if (!body.party_ids?.length) {
          return jsonResponse({ error: 'VALIDATION_ERROR', message: 'party_ids array is required' }, 400)
        }
        const result = await sendInvites(body)
        return jsonResponse(result)
      }

      case 'send-channel': {
        if (!body.channel || !body.party_ids?.length || !body.event_id) {
          return jsonResponse({ error: 'VALIDATION_ERROR', message: 'channel, party_ids, and event_id are required' }, 400)
        }
        const result = await sendChannel(body)
        return jsonResponse(result)
      }

      case 'backfill-geocoding': {
        if (!body.event_id) {
          return jsonResponse({ error: 'VALIDATION_ERROR', message: 'event_id is required' }, 400)
        }
        const result = await backfillGeocoding({ event_id: body.event_id })
        return jsonResponse(result)
      }

      default:
        return jsonResponse({ error: 'INVALID_ACTION', message: `Unknown action: ${action}` }, 400)
    }
  } catch (error) {
    console.error('Error processing admin request:', error)
    return jsonResponse({ error: 'INTERNAL_ERROR', message: 'Internal server error' }, 500)
  }
}
