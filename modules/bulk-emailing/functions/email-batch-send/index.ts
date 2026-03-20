import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Configuration
const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY')!
const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

const BATCH_LIMIT = 50
const PROGRESS_UPDATE_INTERVAL = 10
const CANCEL_CHECK_INTERVAL = 50

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// --- Template Variable Replacement ---

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

// Parse and replace template variables
// Supports: {{scope.field}}, {{scope.field | default:"value"}}, {{scope.field:param}}, {{scope.field:param | default:"value"}}
function replaceVariables(template: string, context: TemplateContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, inner: string) => {
    const trimmed = inner.trim()

    // Split on | to separate field reference from filters
    const segments = trimmed.split('|').map((s: string) => s.trim())
    const fieldRef = segments[0]

    // Parse field reference: scope.field or scope.field:param
    const fieldMatch = fieldRef.match(/^([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)(?::([a-zA-Z0-9_-]+))?$/)
    if (!fieldMatch) return match // Not a valid variable, leave as-is

    const [, scope, field] = fieldMatch

    // Get value from context
    const scopeData = context[scope]
    const value = scopeData?.[field]

    // Parse filters (currently supports: default)
    let defaultValue: string | undefined
    for (let i = 1; i < segments.length; i++) {
      const filterMatch = segments[i].match(/^default:"([^"]*)"$/)
      if (filterMatch) {
        defaultValue = filterMatch[1]
      }
    }

    if (value !== undefined && value !== null && value !== '') return value
    return defaultValue ?? ''
  })
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

// --- SendGrid Sending ---

async function sendViaSendGrid(params: {
  to: string
  from: string
  fromName?: string
  subject: string
  html: string
  replyTo?: string
  cc?: string
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const { to, from, fromName, subject, html, replyTo, cc } = params

  const personalizations: any[] = [{
    to: [{ email: to }],
    ...(cc ? { cc: [{ email: cc }] } : {}),
  }]

  const payload: any = {
    personalizations,
    from: fromName ? { email: from, name: fromName } : { email: from },
    subject,
    content: [{ type: 'text/html', value: html }],
  }
  if (replyTo) {
    payload.reply_to = { email: replyTo }
  }

  const response = await fetch(SENDGRID_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error(`SendGrid error (${response.status}):`, errorText)
    return { success: false, error: `SendGrid ${response.status}: ${errorText}` }
  }

  const messageId = response.headers.get('x-message-id') || undefined
  return { success: true, messageId }
}

// --- Recipient Fetching ---

interface Recipient {
  email: string
  personId?: number
  firstName?: string
  lastName?: string
  fullName?: string
  // Speaker-specific
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
      id,
      created_at,
      people_profiles!inner(
        person_id,
        people!inner(
          id, email, attributes
        )
      )
    `)
    .eq('event_id', eventId)
    .eq('status', 'confirmed')

  // Filter by registration date if specified
  if (registeredAfter) {
    query = query.gt('created_at', registeredAfter)
  }

  // Filter by specific registration IDs if specified
  if (registrationIds && registrationIds.length > 0) {
    query = query.in('id', registrationIds)
  }

  const { data, error } = await query
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1)

  if (error) throw new Error(`Failed to fetch registrations: ${error.message}`)
  if (!data) return []

  return data
    .map((reg: any) => {
      const person = reg.people_profiles?.people
      if (!person?.email) return null
      const attrs = person.attributes || {}
      return {
        email: person.email,
        personId: person.id,
        firstName: attrs.first_name || '',
        lastName: attrs.last_name || '',
        fullName: `${attrs.first_name || ''} ${attrs.last_name || ''}`.trim(),
      }
    })
    .filter(Boolean) as Recipient[]
}

async function fetchAttendeeRecipients(eventId: string, offset: number, limit: number): Promise<Recipient[]> {
  const { data, error } = await supabase
    .from('events_attendance')
    .select(`
      id,
      people_profiles!inner(
        person_id,
        people!inner(
          id, email, attributes
        )
      )
    `)
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
        email: person.email,
        personId: person.id,
        firstName: attrs.first_name || '',
        lastName: attrs.last_name || '',
        fullName: `${attrs.first_name || ''} ${attrs.last_name || ''}`.trim(),
      }
    })
    .filter(Boolean) as Recipient[]
}

async function fetchNonAttendeeRecipients(eventId: string, offset: number, limit: number): Promise<Recipient[]> {
  const { data, error } = await supabase
    .rpc('get_non_attendee_recipients', { p_event_id: eventId, p_offset: offset, p_limit: limit })

  if (error) throw new Error(`Failed to fetch non-attendees: ${error.message}`)
  if (!data) return []

  return data.map((row: any) => {
    const attrs = row.attributes || {}
    return {
      email: row.email,
      personId: row.customer_id,
      firstName: attrs.first_name || '',
      lastName: attrs.last_name || '',
      fullName: `${attrs.first_name || ''} ${attrs.last_name || ''}`.trim(),
    }
  })
}

async function fetchCompetitionNonWinnerRecipients(eventId: string, offset: number, limit: number): Promise<Recipient[]> {
  const { data, error } = await supabase
    .rpc('get_competition_non_winner_recipients', { p_event_id: eventId, p_offset: offset, p_limit: limit })

  if (error) throw new Error(`Failed to fetch competition non-winners: ${error.message}`)
  if (!data) return []

  return data.map((row: any) => {
    const attrs = row.attributes || {}
    return {
      email: row.entry_email || row.email,
      personId: row.customer_id,
      firstName: attrs.first_name || '',
      lastName: attrs.last_name || '',
      fullName: `${attrs.first_name || ''} ${attrs.last_name || ''}`.trim(),
    }
  })
}

async function fetchSpeakerRecipients(
  eventUuid: string,
  speakerStatus: string,
  includeDirectlyAdded: boolean,
  offset: number,
  limit: number
): Promise<Recipient[]> {
  let query = supabase
    .from('events_speakers_with_details')
    .select('*')
    .eq('event_uuid', eventUuid)
    .eq('status', speakerStatus)

  if (!includeDirectlyAdded) {
    query = query.not('submitted_at', 'is', null)
  }

  const { data, error } = await query
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1)

  if (error) throw new Error(`Failed to fetch speakers: ${error.message}`)
  if (!data) return []

  return data.map((s: any) => ({
    email: s.email,
    personId: s.customer_id,
    firstName: s.first_name || '',
    lastName: s.last_name || '',
    fullName: s.full_name || '',
    talkTitle: s.talk_title || '',
    talkSynopsis: s.talk_synopsis || '',
    company: s.company || '',
    jobTitle: s.job_title || '',
    confirmationToken: s.confirmation_token || '',
    editToken: s.edit_token || '',
  }))
}

async function fetchAdhocRecipients(memberProfileIds: string[], offset: number, limit: number): Promise<Recipient[]> {
  // Paginate through the provided member_profile_ids
  const idsPage = memberProfileIds.slice(offset, offset + limit)
  if (idsPage.length === 0) return []

  const { data, error } = await supabase
    .from('people_profiles')
    .select(`
      id,
      person_id,
      people!inner(
        id, email, attributes
      )
    `)
    .in('id', idsPage)

  if (error) throw new Error(`Failed to fetch adhoc recipients: ${error.message}`)
  if (!data) return []

  return data
    .map((mp: any) => {
      const person = mp.people
      if (!person?.email) return null
      const attrs = person.attributes || {}
      return {
        email: person.email,
        personId: person.id,
        firstName: attrs.first_name || '',
        lastName: attrs.last_name || '',
        fullName: `${attrs.first_name || ''} ${attrs.last_name || ''}`.trim(),
        company: attrs.company || '',
        jobTitle: attrs.job_title || '',
      }
    })
    .filter(Boolean) as Recipient[]
}

async function countRecipients(job: any): Promise<number> {
  if (job.email_type === 'adhoc_email') {
    const config = job.config || {}
    return (config.member_profile_ids || []).length
  } else if (job.email_type === 'registration' || job.email_type === 'reminder') {
    const config = job.config || {}
    let query = supabase
      .from('events_registrations')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', job.event_id)
      .eq('status', 'confirmed')

    // Filter by registration date if specified
    if (config.registered_after) {
      query = query.gt('created_at', config.registered_after)
    }

    const { count, error } = await query
    if (error) throw new Error(`Failed to count registrations: ${error.message}`)
    return count || 0
  } else if (job.email_type === 'post_event_attendee') {
    const { count, error } = await supabase
      .from('events_attendance')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', job.event_id)
    if (error) throw new Error(`Failed to count attendees: ${error.message}`)
    return count || 0
  } else if (job.email_type === 'post_event_non_attendee') {
    const { data, error } = await supabase
      .rpc('count_non_attendee_recipients', { p_event_id: job.event_id })
    if (error) throw new Error(`Failed to count non-attendees: ${error.message}`)
    return data || 0
  } else if (job.email_type === 'competition_non_winner') {
    const { data, error } = await supabase
      .rpc('count_competition_non_winner_recipients', { p_event_id: job.event_id })
    if (error) throw new Error(`Failed to count competition non-winners: ${error.message}`)
    return data || 0
  } else if (job.email_type === 'registrant_email') {
    const config = job.config || {}
    if (config.registration_ids && config.registration_ids.length > 0) {
      return config.registration_ids.length
    }
    const { count, error } = await supabase
      .from('events_registrations')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', job.event_id)
      .eq('status', 'confirmed')
    if (error) throw new Error(`Failed to count registrants: ${error.message}`)
    return count || 0
  } else {
    // Speaker email types: speaker_submitted, speaker_approved, etc.
    const config = job.config || {}
    let query = supabase
      .from('events_speakers_with_details')
      .select('*', { count: 'exact', head: true })
      .eq('event_uuid', config.event_uuid)
      .eq('status', config.speaker_status)
    if (!config.include_directly_added) {
      query = query.not('submitted_at', 'is', null)
    }
    const { count, error } = await query
    if (error) throw new Error(`Failed to count speakers: ${error.message}`)
    return count || 0
  }
}

// --- Main Handler ---

export default async function(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  let jobId: string | null = null
  try {
    const body = await req.json()
    jobId = body.jobId
    if (!jobId) {
      return new Response(JSON.stringify({ error: 'jobId is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
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

    // Validate status
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
          status: 'completed',
          total_recipients: 0,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', jobId)
        return new Response(JSON.stringify({ message: 'No recipients found' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      await supabase.from('email_batch_jobs').update({
        status: 'processing',
        total_recipients: totalRecipients,
        updated_at: new Date().toISOString(),
      }).eq('id', jobId)
      job.total_recipients = totalRecipients
    }

    // Fetch event details for template context
    const { data: event } = await supabase
      .from('events')
      .select('event_id, event_title, event_city, event_country_code, event_start, event_end, event_link, event_location')
      .eq('event_id', job.event_id)
      .single()

    // Parse from address for name
    let fromEmail = job.from_address
    let fromName: string | undefined
    const fromMatch = job.from_address.match(/^(.+?)\s*-\s*(.+@.+)$/)
    if (fromMatch) {
      fromName = fromMatch[1].trim()
      fromEmail = fromMatch[2].trim()
    }

    // Fetch batch of recipients
    const config = job.config || {}
    const offset = job.last_processed_offset || 0
    let recipients: Recipient[]

    if (job.email_type === 'adhoc_email') {
      recipients = await fetchAdhocRecipients(config.member_profile_ids || [], offset, BATCH_LIMIT)
    } else if (job.email_type === 'registration' || job.email_type === 'reminder') {
      recipients = await fetchRegistrationRecipients(job.event_id, offset, BATCH_LIMIT, config.registered_after)
    } else if (job.email_type === 'registrant_email') {
      recipients = await fetchRegistrationRecipients(job.event_id, offset, BATCH_LIMIT, undefined, config.registration_ids)
    } else if (job.email_type === 'post_event_attendee') {
      recipients = await fetchAttendeeRecipients(job.event_id, offset, BATCH_LIMIT)
    } else if (job.email_type === 'post_event_non_attendee') {
      recipients = await fetchNonAttendeeRecipients(job.event_id, offset, BATCH_LIMIT)
    } else if (job.email_type === 'competition_non_winner') {
      recipients = await fetchCompetitionNonWinnerRecipients(job.event_id, offset, BATCH_LIMIT)
    } else {
      recipients = await fetchSpeakerRecipients(
        config.event_uuid,
        config.speaker_status,
        config.include_directly_added || false,
        offset, BATCH_LIMIT
      )
    }

    console.log(`Job ${jobId}: Processing ${recipients.length} recipients (offset ${offset}, total ${job.total_recipients})`)

    let processed = job.processed_count || 0
    let successful = job.success_count || 0
    let failed = job.fail_count || 0
    const errors: any[] = Array.isArray(job.errors) ? [...job.errors] : []

    for (let i = 0; i < recipients.length; i++) {
      // Check for cancellation
      if (i > 0 && i % CANCEL_CHECK_INTERVAL === 0) {
        const { data: currentJob } = await supabase
          .from('email_batch_jobs')
          .select('status')
          .eq('id', jobId)
          .single()
        if (currentJob?.status === 'cancelled') {
          console.log(`Job ${jobId} was cancelled, stopping`)
          break
        }
      }

      const recipient = recipients[i]
      if (!recipient.email) {
        processed++
        continue
      }

      try {
        // Build template context
        const context: TemplateContext = {
          customer: {
            first_name: recipient.firstName,
            last_name: recipient.lastName,
            full_name: recipient.fullName,
            email: recipient.email,
          },
          event: {
            name: event?.event_title || '',
            id: event?.event_id || '',
            city: event?.event_city || '',
            country: event?.event_country_code || '',
            start_date: formatDate(event?.event_start),
            end_date: formatDate(event?.event_end),
            link: event?.event_link || '',
            location: event?.event_location || '',
          },
        }

        // Add calendar links for registration and reminder emails
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

        // Add speaker context (only for speaker email types, or adhoc with speakers audience)
        const nonSpeakerTypes = ['registration', 'reminder', 'post_event_attendee', 'post_event_non_attendee', 'competition_non_winner', 'registrant_email']
        const isAdhocSpeaker = job.email_type === 'adhoc_email' && config.audience_type === 'speakers'
        if (!nonSpeakerTypes.includes(job.email_type) || isAdhocSpeaker) {
          const confirmationLink = recipient.confirmationToken
            ? `${SUPABASE_URL}/functions/v1/speaker-confirm?token=${recipient.confirmationToken}`
            : ''
          const editLink = recipient.editToken
            ? `/events/${job.event_id}/talks/success/${recipient.editToken}`
            : ''

          context.speaker = {
            first_name: recipient.firstName,
            last_name: recipient.lastName,
            full_name: recipient.fullName,
            email: recipient.email,
            talk_title: recipient.talkTitle,
            talk_synopsis: recipient.talkSynopsis,
            company: recipient.company,
            job_title: recipient.jobTitle,
            confirmation_link: confirmationLink,
            edit_link: editLink,
          }
        }

        // Replace variables
        const processedSubject = replaceVariables(job.subject_template, context)
        const processedHtml = replaceVariables(job.content_template, context)

        // Send email
        const result = await sendViaSendGrid({
          to: recipient.email,
          from: fromEmail,
          fromName,
          subject: processedSubject,
          html: processedHtml,
          replyTo: job.reply_to || undefined,
          cc: job.cc || undefined,
        })

        // Log to email_logs
        await supabase.from('email_logs').insert({
          recipient_email: recipient.email,
          recipient_customer_id: recipient.personId || null,
          from_address: fromEmail,
          reply_to: job.reply_to || null,
          subject: processedSubject,
          content_html: processedHtml,
          sendgrid_message_id: result.messageId || null,
          status: result.success ? 'sent' : 'failed',
          sent_by_admin_user_id: job.created_by,
          batch_job_id: jobId,
        })

        if (result.success) {
          successful++
        } else {
          failed++
          errors.push({ email: recipient.email, error: result.error })
          if (errors.length > 50) errors.shift()
        }
      } catch (err: any) {
        failed++
        errors.push({ email: recipient.email, error: err.message })
        if (errors.length > 50) errors.shift()
        console.error(`Error sending to ${recipient.email}:`, err.message)
      }

      processed++

      // Update progress periodically
      if (i > 0 && (i % PROGRESS_UPDATE_INTERVAL === 0 || i === recipients.length - 1)) {
        await supabase.from('email_batch_jobs').update({
          processed_count: processed,
          success_count: successful,
          fail_count: failed,
          errors,
          last_processed_offset: offset + i + 1,
          updated_at: new Date().toISOString(),
        }).eq('id', jobId)
      }
    }

    // Final progress update for this batch
    const newOffset = offset + recipients.length
    await supabase.from('email_batch_jobs').update({
      processed_count: processed,
      success_count: successful,
      fail_count: failed,
      errors,
      last_processed_offset: newOffset,
      updated_at: new Date().toISOString(),
    }).eq('id', jobId)

    // Check if cancelled
    const { data: latestJob } = await supabase
      .from('email_batch_jobs')
      .select('status')
      .eq('id', jobId)
      .single()

    if (latestJob?.status === 'cancelled') {
      console.log(`Job ${jobId}: Cancelled. Processed ${processed}, success ${successful}, failed ${failed}`)
      return new Response(JSON.stringify({ message: 'Job cancelled', processed, successful, failed }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Check if there are more recipients
    if (recipients.length === BATCH_LIMIT && newOffset < job.total_recipients) {
      console.log(`Job ${jobId}: ${job.total_recipients - newOffset} remaining, chaining next batch`)

      // Self-invoke for next batch (fire-and-forget)
      fetch(`${SUPABASE_URL}/functions/v1/batch-send-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ jobId }),
      }).catch((err) => console.error('Failed to chain next batch:', err))

      return new Response(JSON.stringify({
        message: 'Batch processed, continuing',
        processed,
        successful,
        failed,
        remaining: job.total_recipients - newOffset,
      }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // All done
    await supabase.from('email_batch_jobs').update({
      status: 'completed',
      processed_count: processed,
      success_count: successful,
      fail_count: failed,
      errors,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', jobId)

    console.log(`Job ${jobId}: Completed. Sent ${successful}, failed ${failed}, total ${processed}`)

    return new Response(JSON.stringify({
      message: 'Job completed',
      processed,
      successful,
      failed,
    }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error: any) {
    console.error('batch-send-email error:', error)

    // Mark job as failed if we have the jobId
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
  }
}
