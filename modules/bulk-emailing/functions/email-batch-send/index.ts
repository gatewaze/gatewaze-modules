import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { jobIdToLockKey } from '../_shared/retry.ts'

// Configuration
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

// Recipient page size for the enqueue loop.
const BATCH_LIMIT = 50

// Central Sending Service: this fn ENQUEUES resolved recipients (with each
// one's substitution context) into email_batch_job_recipients; the shared
// worker drip engine sends them.

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// --- Template Variable Substitution Context ---
//
// The Tier-2 worker engine renders `{{scope.field|default:"..."}}` tokens at
// dispatch time against each recipient's stored template_variables (see the
// bulk send-engine binding). This Edge function only builds the per-recipient
// context and enqueues it.

function encodeEmail(email: string): string {
  if (!email) return ''
  const passphrase = 'HideMe'
  const emailLower = email.toLowerCase()
  const bytes: number[] = []
  for (let i = 0; i < emailLower.length; i++) {
    bytes.push(emailLower.charCodeAt(i) ^ passphrase.charCodeAt(i % passphrase.length))
  }
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

interface TemplateContext {
  [scope: string]: Record<string, string | undefined> | undefined
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    })
  } catch {
    return ''
  }
}

// --- Recipient Fetching ---

interface Recipient {
  email: string
  personId?: number
  firstName?: string
  lastName?: string
  fullName?: string
  talkTitle?: string
  talkSynopsis?: string
  company?: string
  jobTitle?: string
  confirmationToken?: string
  editToken?: string
}

async function fetchRegistrationRecipients(eventId: string, offset: number, limit: number, registeredAfter?: string, registrationIds?: string[]): Promise<Recipient[]> {
  let query = supabase
    .from('events_registrations')
    .select(`
      id, created_at,
      people_profiles!inner(
        person_id,
        people!inner(id, email, attributes)
      )
    `)
    .eq('event_id', eventId)
    .eq('status', 'confirmed')

  if (registeredAfter) query = query.gt('created_at', registeredAfter)
  if (registrationIds && registrationIds.length > 0) query = query.in('id', registrationIds)

  const { data, error } = await query.order('id', { ascending: true }).range(offset, offset + limit - 1)
  if (error) throw new Error(`Failed to fetch registrations: ${error.message}`)
  if (!data) return []

  return data
    .map((reg: any) => {
      const person = reg.people_profiles?.people
      if (!person?.email) return null
      const attrs = person.attributes || {}
      return {
        email: person.email, personId: person.id,
        firstName: attrs.first_name || '', lastName: attrs.last_name || '',
        fullName: `${attrs.first_name || ''} ${attrs.last_name || ''}`.trim(),
      }
    })
    .filter(Boolean) as Recipient[]
}

async function fetchAttendeeRecipients(eventId: string, offset: number, limit: number): Promise<Recipient[]> {
  const { data, error } = await supabase
    .from('events_attendance')
    .select(`id, people_profiles!inner(person_id, people!inner(id, email, attributes))`)
    .eq('event_id', eventId)
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1)
  if (error) throw new Error(`Failed to fetch attendees: ${error.message}`)
  if (!data) return []

  return data
    .map((att: any) => {
      const person = att.people_profiles?.people
      if (!person?.email) return null
      const attrs = person.attributes || {}
      return {
        email: person.email, personId: person.id,
        firstName: attrs.first_name || '', lastName: attrs.last_name || '',
        fullName: `${attrs.first_name || ''} ${attrs.last_name || ''}`.trim(),
      }
    })
    .filter(Boolean) as Recipient[]
}

async function fetchNonAttendeeRecipients(eventId: string, offset: number, limit: number): Promise<Recipient[]> {
  const { data, error } = await supabase.rpc('get_non_attendee_recipients', { p_event_id: eventId, p_offset: offset, p_limit: limit })
  if (error) throw new Error(`Failed to fetch non-attendees: ${error.message}`)
  if (!data) return []
  return data.map((row: any) => {
    const attrs = row.attributes || {}
    return {
      email: row.email, personId: row.customer_id,
      firstName: attrs.first_name || '', lastName: attrs.last_name || '',
      fullName: `${attrs.first_name || ''} ${attrs.last_name || ''}`.trim(),
    }
  })
}

async function fetchCompetitionNonWinnerRecipients(eventId: string, offset: number, limit: number): Promise<Recipient[]> {
  const { data, error } = await supabase.rpc('get_competition_non_winner_recipients', { p_event_id: eventId, p_offset: offset, p_limit: limit })
  if (error) throw new Error(`Failed to fetch competition non-winners: ${error.message}`)
  if (!data) return []
  return data.map((row: any) => {
    const attrs = row.attributes || {}
    return {
      email: row.entry_email || row.email, personId: row.customer_id,
      firstName: attrs.first_name || '', lastName: attrs.last_name || '',
      fullName: `${attrs.first_name || ''} ${attrs.last_name || ''}`.trim(),
    }
  })
}

async function fetchSpeakerRecipients(eventUuid: string, speakerStatus: string, includeDirectlyAdded: boolean, offset: number, limit: number): Promise<Recipient[]> {
  let query = supabase.from('events_speakers_with_details').select('*').eq('event_uuid', eventUuid).eq('status', speakerStatus)
  if (!includeDirectlyAdded) query = query.not('submitted_at', 'is', null)
  const { data, error } = await query.order('id', { ascending: true }).range(offset, offset + limit - 1)
  if (error) throw new Error(`Failed to fetch speakers: ${error.message}`)
  if (!data) return []
  return data.map((s: any) => ({
    email: s.email, personId: s.customer_id,
    firstName: s.first_name || '', lastName: s.last_name || '', fullName: s.full_name || '',
    talkTitle: s.talk_title || '', talkSynopsis: s.talk_synopsis || '',
    company: s.company || '', jobTitle: s.job_title || '',
    confirmationToken: s.confirmation_token || '', editToken: s.edit_token || '',
  }))
}

async function fetchAdhocRecipients(memberProfileIds: string[], offset: number, limit: number): Promise<Recipient[]> {
  const idsPage = memberProfileIds.slice(offset, offset + limit)
  if (idsPage.length === 0) return []
  const { data, error } = await supabase
    .from('people_profiles')
    .select(`id, person_id, people!inner(id, email, attributes)`)
    .in('id', idsPage)
  if (error) throw new Error(`Failed to fetch adhoc recipients: ${error.message}`)
  if (!data) return []
  return data
    .map((mp: any) => {
      const person = mp.people
      if (!person?.email) return null
      const attrs = person.attributes || {}
      return {
        email: person.email, personId: person.id,
        firstName: attrs.first_name || '', lastName: attrs.last_name || '',
        fullName: `${attrs.first_name || ''} ${attrs.last_name || ''}`.trim(),
        company: attrs.company || '', jobTitle: attrs.job_title || '',
      }
    })
    .filter(Boolean) as Recipient[]
}

// Per spec-calendars-microsites §8.4 — calendars source. Resolves the
// audience via resolve_calendar_audience(p_calendar_id, p_filter, p_channel).
// Returns paged Recipient[] in the same shape as the per-event fetchers.
//
// The job carries the calendar id in source_id (per migration 006) and the
// audience_filter in config.audience_filter (set by sendBlast).
async function fetchCalendarBlastRecipients(job: any, offset: number, limit: number): Promise<Recipient[]> {
  const config = job.config || {}
  const filter = config.audience_filter || {}
  const calendarId = job.source_id
  if (!calendarId) {
    throw new Error('calendar_blast job missing source_id')
  }
  const { data, error } = await supabase.rpc('resolve_calendar_audience', {
    p_calendar_id: calendarId,
    p_filter: filter,
    p_channel: 'email',
  })
  if (error) throw new Error(`resolve_calendar_audience failed: ${error.message}`)
  const rows = (data || []) as Array<{ member_id: string; person_id: string | null; email: string | null }>
  // Audience resolver returns the full set; we paginate client-side. Typical
  // calendar blast is < 1000 recipients; if this becomes a perf issue,
  // resolve_calendar_audience can grow OFFSET/LIMIT params.
  return rows
    .filter((r) => !!r.email)
    .slice(offset, offset + limit)
    .map((r) => ({
      email: r.email!,
      personId: r.person_id ?? undefined,
      firstName: '',
      lastName: '',
      fullName: '',
    }))
}

async function countRecipients(job: any): Promise<number> {
  if (job.email_type === 'calendar_blast') {
    // Same RPC as fetch — count is just rows.length. The job row's
    // total_recipients was pre-set by sendBlast, but we re-count to
    // avoid a stale snapshot if membership changed between schedule
    // and send.
    const config = job.config || {}
    const { data, error } = await supabase.rpc('resolve_calendar_audience', {
      p_calendar_id: job.source_id,
      p_filter: config.audience_filter || {},
      p_channel: 'email',
    })
    if (error) throw new Error(`Failed to count calendar audience: ${error.message}`)
    const rows = (data || []) as Array<{ email: string | null }>
    return rows.filter((r) => !!r.email).length
  } else if (job.email_type === 'adhoc_email') {
    return (job.config?.member_profile_ids || []).length
  } else if (job.email_type === 'registration' || job.email_type === 'reminder') {
    const config = job.config || {}
    let query = supabase.from('events_registrations').select('*', { count: 'exact', head: true }).eq('event_id', job.event_id).eq('status', 'confirmed')
    if (config.registered_after) query = query.gt('created_at', config.registered_after)
    const { count, error } = await query
    if (error) throw new Error(`Failed to count registrations: ${error.message}`)
    return count || 0
  } else if (job.email_type === 'post_event_attendee') {
    const { count, error } = await supabase.from('events_attendance').select('*', { count: 'exact', head: true }).eq('event_id', job.event_id)
    if (error) throw new Error(`Failed to count attendees: ${error.message}`)
    return count || 0
  } else if (job.email_type === 'post_event_non_attendee') {
    const { data, error } = await supabase.rpc('count_non_attendee_recipients', { p_event_id: job.event_id })
    if (error) throw new Error(`Failed to count non-attendees: ${error.message}`)
    return data || 0
  } else if (job.email_type === 'competition_non_winner') {
    const { data, error } = await supabase.rpc('count_competition_non_winner_recipients', { p_event_id: job.event_id })
    if (error) throw new Error(`Failed to count competition non-winners: ${error.message}`)
    return data || 0
  } else if (job.email_type === 'registrant_email') {
    const config = job.config || {}
    if (config.registration_ids?.length > 0) return config.registration_ids.length
    const { count, error } = await supabase.from('events_registrations').select('*', { count: 'exact', head: true }).eq('event_id', job.event_id).eq('status', 'confirmed')
    if (error) throw new Error(`Failed to count registrants: ${error.message}`)
    return count || 0
  } else {
    const config = job.config || {}
    let query = supabase.from('events_speakers_with_details').select('*', { count: 'exact', head: true }).eq('event_uuid', config.event_uuid).eq('status', config.speaker_status)
    if (!config.include_directly_added) query = query.not('submitted_at', 'is', null)
    const { count, error } = await query
    if (error) throw new Error(`Failed to count speakers: ${error.message}`)
    return count || 0
  }
}

// Build the per-recipient substitution context (customer / event / calendar /
// speaker scopes). Shared by the inline Tier-1 send and the Tier-2 enqueue so
// both produce identical {{scope.field}} values.
function buildRecipientContext(job: any, event: any, config: any, recipient: Recipient): TemplateContext {
  const context: TemplateContext = {
    customer: {
      first_name: recipient.firstName, last_name: recipient.lastName,
      full_name: recipient.fullName, email: recipient.email,
    },
    event: {
      name: event?.event_title || '', id: event?.event_id || '',
      city: event?.event_city || '', country: event?.event_country_code || '',
      start_date: formatDate(event?.event_start), end_date: formatDate(event?.event_end),
      link: event?.event_link || '', location: event?.event_location || '',
    },
  }

  if (job.email_type === 'registration' || job.email_type === 'reminder') {
    const encodedEmail = encodeEmail(recipient.email)
    const calendarBase = `${SUPABASE_URL}/functions/v1/calendar/${job.event_id}`
    context.calendar = {
      google: `${calendarBase}/google/${encodedEmail}`,
      outlook: `${calendarBase}/outlook/${encodedEmail}`,
      apple: `${calendarBase}/apple/${encodedEmail}`,
      ics: `${calendarBase}/ics/${encodedEmail}`,
    }
  }

  const nonSpeakerTypes = ['registration', 'reminder', 'post_event_attendee', 'post_event_non_attendee', 'competition_non_winner', 'registrant_email']
  const isAdhocSpeaker = job.email_type === 'adhoc_email' && config.audience_type === 'speakers'
  if (!nonSpeakerTypes.includes(job.email_type) || isAdhocSpeaker) {
    const confirmationLink = recipient.confirmationToken
      ? `${SUPABASE_URL}/functions/v1/speaker-confirm?token=${recipient.confirmationToken}` : ''
    const editLink = recipient.editToken ? `/events/${job.event_id}/talks/success/${recipient.editToken}` : ''
    context.speaker = {
      first_name: recipient.firstName, last_name: recipient.lastName,
      full_name: recipient.fullName, email: recipient.email,
      talk_title: recipient.talkTitle, talk_synopsis: recipient.talkSynopsis,
      company: recipient.company, job_title: recipient.jobTitle,
      confirmation_link: confirmationLink, edit_link: editLink,
    }
  }
  return context
}

// Dispatch to the right per-audience fetcher for a page of recipients. Shared by
// the inline send and the Tier-2 enqueue (same resolution for both).
async function fetchRecipientsPage(job: any, config: any, offset: number, limit: number): Promise<Recipient[]> {
  if (job.email_type === 'calendar_blast') return fetchCalendarBlastRecipients(job, offset, limit)
  if (job.email_type === 'adhoc_email') return fetchAdhocRecipients(config.member_profile_ids || [], offset, limit)
  if (job.email_type === 'registration' || job.email_type === 'reminder') return fetchRegistrationRecipients(job.event_id, offset, limit, config.registered_after)
  if (job.email_type === 'registrant_email') return fetchRegistrationRecipients(job.event_id, offset, limit, undefined, config.registration_ids)
  if (job.email_type === 'post_event_attendee') return fetchAttendeeRecipients(job.event_id, offset, limit)
  if (job.email_type === 'post_event_non_attendee') return fetchNonAttendeeRecipients(job.event_id, offset, limit)
  if (job.email_type === 'competition_non_winner') return fetchCompetitionNonWinnerRecipients(job.event_id, offset, limit)
  return fetchSpeakerRecipients(config.event_uuid, config.speaker_status, config.include_directly_added || false, offset, limit)
}

// Tier 2: page through ALL recipients and enqueue them (with each one's
// substitution context as jsonb) into the drip queue. The shared worker engine
// then claims due rows and sends them. Idempotent via the (job_id, email)
// unique key — re-running an enqueue won't duplicate recipients.
async function enqueueAllRecipients(job: any, event: any, config: any): Promise<number> {
  const jobId = job.id
  const sendAt = new Date().toISOString()
  let offset = 0
  let total = 0
  while (true) {
    const page = await fetchRecipientsPage(job, config, offset, BATCH_LIMIT)
    if (page.length === 0) break
    const rows = page
      .filter((r) => !!r.email)
      .map((r) => ({
        send_id: jobId,
        email: r.email,
        person_id: r.personId != null ? String(r.personId) : null,
        context: buildRecipientContext(job, event, config, r),
        send_at: sendAt,
        status: 'pending',
        strategy: 'global',
      }))
    if (rows.length > 0) {
      const { error } = await supabase
        .from('email_batch_job_recipients')
        .upsert(rows, { onConflict: 'send_id,email', ignoreDuplicates: true })
      if (error) throw new Error(`Enqueue failed: ${error.message}`)
      total += rows.length
    }
    offset += page.length
    if (page.length < BATCH_LIMIT) break
  }
  return total
}

// --- Main Handler ---

export default async function(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  let jobId: string | null = null
  let lockKey: number | null = null

  try {
    const body = await req.json()
    jobId = body.jobId
    if (!jobId) {
      return new Response(JSON.stringify({ error: 'jobId is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Acquire advisory lock to prevent concurrent processing
    lockKey = jobIdToLockKey(jobId)
    const { data: lockAcquired } = await supabase.rpc('try_advisory_lock', { lock_key: lockKey })
    if (!lockAcquired) {
      return new Response(JSON.stringify({ error: 'Job is already being processed by another invocation' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Load job
    const { data: job, error: jobError } = await supabase
      .from('email_batch_jobs')
      .select('*')
      .eq('id', jobId)
      .single()

    if (jobError || !job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (job.status === 'completed' || job.status === 'cancelled') {
      return new Response(JSON.stringify({ message: `Job already ${job.status}` }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (job.status === 'failed') {
      return new Response(JSON.stringify({ error: 'Job has failed' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Set to processing + count recipients on first run
    if (job.status === 'pending') {
      const totalRecipients = await countRecipients(job)
      if (totalRecipients === 0) {
        await supabase.from('email_batch_jobs').update({
          status: 'completed', total_recipients: 0,
          completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', jobId)
        return new Response(JSON.stringify({ message: 'No recipients found' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      await supabase.from('email_batch_jobs').update({
        status: 'processing', total_recipients: totalRecipients,
        last_heartbeat_at: new Date().toISOString(),
        stall_count: 0,
        updated_at: new Date().toISOString(),
      }).eq('id', jobId)
      job.total_recipients = totalRecipients
    } else {
      // Reset stall count on successful resume and update heartbeat
      await supabase.from('email_batch_jobs').update({
        status: 'processing',
        last_heartbeat_at: new Date().toISOString(),
        stall_count: 0,
        updated_at: new Date().toISOString(),
      }).eq('id', jobId)
    }

    // Fetch event details — used by buildRecipientContext to populate
    // {{event.*}} substitution variables on the enqueued recipient rows.
    const { data: event } = await supabase
      .from('events')
      .select('event_id, event_title, event_city, event_country_code, event_start, event_end, event_link, event_location')
      .eq('event_id', job.event_id)
      .single()

    const config = job.config || {}

    // Enqueue all recipients (with substitution context) for the shared worker
    // drip engine, then return — the worker sends them.
    //
    // NOTE: calendar_blast finalisation (calendars_blasts.status flip) used to
    // live in the deleted legacy inline-send branch. The Tier-2 worker engine
    // owns lifecycle now, so that cross-table side effect needs to be wired
    // into the worker's per-domain finalize hook (or the calendars
    // dispatch-scheduled-blasts worker can reconcile from email_batch_jobs.
    // status). See spec-calendars-microsites §8.4. Tracked separately —
    // production has been running on the worker path so this is a pre-existing
    // gap, not a regression introduced by deleting the Tier-1 path.
    const enqueued = await enqueueAllRecipients(job, event, config)
    const now = new Date().toISOString()
    await supabase.from('email_batch_jobs').update({
      status: enqueued > 0 ? 'sending' : 'completed',
      total_recipients: enqueued,
      last_processed_offset: 0,
      last_heartbeat_at: now,
      updated_at: now,
      ...(enqueued > 0 ? {} : { completed_at: now }),
    }).eq('id', jobId)
    console.log(`Job ${jobId}: enqueued ${enqueued} recipients for worker drip`)
    return new Response(JSON.stringify({
      jobId, status: enqueued > 0 ? 'sending' : 'completed', enqueued,
      message: enqueued > 0 ? 'Enqueued for worker drip' : 'No recipients found',
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (error: any) {
    console.error('email-batch-send error:', error)
    if (jobId) {
      await supabase.from('email_batch_jobs').update({
        status: 'failed',
        errors: [{ error: error.message }],
        updated_at: new Date().toISOString(),
      }).eq('id', jobId).catch(() => {})
    }
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } finally {
    // Release advisory lock
    if (lockKey !== null) {
      await supabase.rpc('release_advisory_lock', { lock_key: lockKey }).catch(() => {})
    }
  }
}
