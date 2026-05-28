import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  createFullRegistration,
  type RegistrationData,
  type EventData,
} from '../_shared/lumaRegistration.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const customerioSiteId = Deno.env.get('CUSTOMERIO_SITE_ID') || Deno.env.get('VITE_CUSTOMERIO_SITE_ID')
const customerioApiKey = Deno.env.get('CUSTOMERIO_API_KEY') || Deno.env.get('VITE_CUSTOMERIO_API_KEY')

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

// =============================================================================
// Type Definitions
// =============================================================================

interface GradualHistoricRecord {
  id: string
  type: 'userRegistersForEvent' | 'userAttendsEvent' | string
  dateOfRegistration?: string
  virtualTicketImageUrl?: string
  virtualTicketPageUrl?: string
  userEmail: string
  userFirstName?: string
  userLastName?: string
  userTitle?: string
  userCompany?: string
  userLinkedIn?: string
  userId?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  utmTerm?: string
  referUrl?: string
  eventId?: string
  eventName?: string
  eventSlug?: string
  eventUrl?: string
  attendeeId?: string
  ticketType?: string
  timestamp?: string
  eventQuestions?: string
}

interface ImportResult {
  total: number
  processed: number
  registrations_created: number
  registrations_pending: number
  attendance_created: number
  attendance_pending: number
  people_created: number
  people_updated: number
  skipped: number
  errors: Array<{ id: string; email: string; error: string }>
}

// =============================================================================
// Database Operations
// =============================================================================

async function findEventByGradualSlug(
  eventSlug: string
): Promise<{ id: string; event_id: string; event_title: string; city?: string; country_code?: string; venue_address?: string } | null> {
  const { data, error } = await supabase
    .from('events')
    .select('id, event_id, event_title, city, country_code, venue_address')
    .eq('gradual_eventslug', eventSlug)
    .maybeSingle()

  if (error) {
    console.error('Error looking up event by gradual_eventslug:', error)
    return null
  }

  return data
}

async function ensureAuthUser(
  email: string,
  attributes: Record<string, unknown>
): Promise<string | null> {
  const { data: existingUsersData, error: listError } = await supabase.auth.admin.listUsers()

  if (listError) {
    console.error('Error listing users:', listError)
  }

  const existingAuthUser = existingUsersData?.users?.find(
    (u: { email?: string }) => u.email?.toLowerCase() === email.toLowerCase()
  )

  if (existingAuthUser) {
    return existingAuthUser.id
  }

  const userMetadata = {
    created_via: 'gradual_import',
    first_name: attributes.first_name || '',
    last_name: attributes.last_name || '',
    company: attributes.company || '',
    job_title: attributes.job_title || '',
    linkedin_url: attributes.linkedin_url || '',
    gradual_user_id: attributes.gradual_user_id || '',
  }

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: email,
    email_confirm: true,
    user_metadata: userMetadata,
  })

  if (authError) {
    if (
      authError.message.includes('already registered') ||
      authError.message.includes('already exists')
    ) {
      const { data: retryData } = await supabase.auth.admin.listUsers()
      const retryUser = retryData?.users?.find(
        (u: { email?: string }) => u.email?.toLowerCase() === email.toLowerCase()
      )
      if (retryUser) {
        return retryUser.id
      }
    }
    console.error('Error creating auth user:', authError)
    return null
  }

  return authData?.user?.id || null
}

async function upsertPerson(record: GradualHistoricRecord): Promise<{ id: number; isNew: boolean } | null> {
  if (!record.userEmail) {
    return null
  }

  const email = record.userEmail.toLowerCase()
  const attributes: Record<string, unknown> = {
    gradual_user_id: record.userId,
    first_name: record.userFirstName,
    last_name: record.userLastName,
    company: record.userCompany,
    job_title: record.userTitle,
    linkedin_url: record.userLinkedIn,
  }

  if (record.utmSource) attributes.utm_source = record.utmSource
  if (record.utmMedium) attributes.utm_medium = record.utmMedium
  if (record.utmCampaign) attributes.utm_campaign = record.utmCampaign
  if (record.utmContent) attributes.utm_content = record.utmContent
  if (record.referUrl) attributes.refer_url = record.referUrl

  Object.keys(attributes).forEach((key) => {
    if (attributes[key] === undefined || attributes[key] === '') {
      delete attributes[key]
    }
  })

  const { data: existingPerson, error: lookupError } = await supabase
    .from('people')
    .select('id, cio_id, email, attributes, auth_user_id')
    .ilike('email', email)
    .maybeSingle()

  if (lookupError) {
    console.error('Error looking up person:', lookupError)
  }

  const now = new Date().toISOString()

  if (existingPerson) {
    const mergedAttributes = {
      ...existingPerson.attributes,
      ...attributes,
      last_gradual_import: now,
    }

    const { error } = await supabase
      .from('people')
      .update({
        attributes: mergedAttributes,
        last_synced_at: now,
      })
      .eq('id', existingPerson.id)

    if (error) {
      console.error('Error updating person:', error)
      return null
    }

    if (!existingPerson.auth_user_id) {
      const authUserId = await ensureAuthUser(email, attributes)
      if (authUserId) {
        await supabase
          .from('people')
          .update({ auth_user_id: authUserId })
          .eq('id', existingPerson.id)
      }
    }

    return { id: existingPerson.id, isNew: false }
  } else {
    const authUserId = await ensureAuthUser(email, attributes)

    const { data, error } = await supabase
      .from('people')
      .insert({
        email: email,
        cio_id: `email:${email}`,
        auth_user_id: authUserId,
        attributes: {
          ...attributes,
          source: 'gradual_import',
          last_gradual_import: now,
        },
        last_synced_at: now,
      })
      .select('id')
      .single()

    if (error) {
      console.error('Error creating person:', error)
      return null
    }

    return { id: data.id, isNew: true }
  }
}

async function findProfileByEmail(email: string): Promise<string | null> {
  const { data: person } = await supabase
    .from('people')
    .select('id')
    .ilike('email', email)
    .maybeSingle()

  if (!person) {
    return null
  }

  const { data: profile } = await supabase
    .from('people_profiles')
    .select('id')
    .eq('person_id', person.id)
    .maybeSingle()

  return profile?.id || null
}

async function storePendingRegistration(record: GradualHistoricRecord): Promise<{ id: string } | null> {
  try {
    const { data, error } = await supabase
      .from('gradual_pending_registrations')
      .upsert(
        {
          gradual_user_id: record.userId,
          gradual_eventslug: record.eventSlug,
          user_email: record.userEmail?.toLowerCase(),
          user_first_name: record.userFirstName,
          user_last_name: record.userLastName,
          user_company: record.userCompany,
          user_title: record.userTitle,
          user_linkedin: record.userLinkedIn,
          event_name: record.eventName,
          event_url: record.eventUrl,
          registration_date: record.dateOfRegistration || record.timestamp,
          utm_source: record.utmSource,
          utm_medium: record.utmMedium,
          utm_campaign: record.utmCampaign,
          utm_content: record.utmContent,
          utm_term: record.utmTerm,
          refer_url: record.referUrl,
          status: 'pending',
          raw_webhook_payload: record,
        },
        {
          onConflict: 'gradual_eventslug,user_email',
          ignoreDuplicates: false,
        }
      )
      .select('id')
      .single()

    if (error) {
      console.error('Error storing pending registration:', error)
      return null
    }

    return data
  } catch (error) {
    console.error('Error in storePendingRegistration:', error)
    return null
  }
}

async function storePendingAttendance(record: GradualHistoricRecord): Promise<{ id: string } | null> {
  try {
    const { data, error } = await supabase
      .from('gradual_pending_attendance')
      .upsert(
        {
          gradual_user_id: record.userId,
          gradual_eventslug: record.eventSlug,
          user_email: record.userEmail?.toLowerCase(),
          user_first_name: record.userFirstName,
          user_last_name: record.userLastName,
          user_company: record.userCompany,
          user_title: record.userTitle,
          user_linkedin: record.userLinkedIn,
          event_name: record.eventName,
          event_url: record.eventUrl,
          attendance_date: record.timestamp || record.dateOfRegistration,
          status: 'pending',
          raw_webhook_payload: record,
        },
        {
          onConflict: 'gradual_eventslug,user_email',
          ignoreDuplicates: false,
        }
      )
      .select('id')
      .single()

    if (error) {
      console.error('Error storing pending attendance:', error)
      return null
    }

    return data
  } catch (error) {
    console.error('Error in storePendingAttendance:', error)
    return null
  }
}

async function createEventAttendance(
  eventId: string,
  memberProfileId: string,
  checkInTime: string
): Promise<{ id: string } | null> {
  const { data: existing } = await supabase
    .from('events_attendance')
    .select('id')
    .eq('event_id', eventId)
    .eq('people_profile_id', memberProfileId)
    .maybeSingle()

  if (existing) {
    return existing
  }

  const { data, error } = await supabase
    .from('events_attendance')
    .insert({
      event_id: eventId,
      people_profile_id: memberProfileId,
      checked_in_at: checkInTime,
      check_in_method: 'gradual_import',
    })
    .select('id')
    .single()

  if (error) {
    console.error('Error creating event attendance:', error)
    return null
  }

  return data
}

// =============================================================================
// Record Processing
// =============================================================================

async function processRegistration(
  record: GradualHistoricRecord,
  result: ImportResult
): Promise<void> {
  if (!record.eventSlug) {
    result.errors.push({ id: record.id, email: record.userEmail, error: 'Missing eventSlug' })
    result.skipped++
    return
  }

  const event = await findEventByGradualSlug(record.eventSlug)

  if (!event) {
    // Store as pending registration
    const pending = await storePendingRegistration(record)
    if (pending) {
      result.registrations_pending++
    } else {
      result.errors.push({ id: record.id, email: record.userEmail, error: 'Failed to store pending registration' })
    }
    return
  }

  // Parse event questions if present
  let registrationAnswers: Record<string, unknown>[] | undefined
  if (record.eventQuestions && record.eventQuestions !== '') {
    try {
      const parsed = JSON.parse(record.eventQuestions)
      if (typeof parsed === 'object' && Object.keys(parsed).length > 0) {
        registrationAnswers = Object.entries(parsed).map(([question, answer]) => ({
          question,
          answer,
          source: 'gradual_import',
        }))
      }
    } catch {
      // Ignore parse errors
    }
  }

  const registrationData: RegistrationData = {
    email: record.userEmail || '',
    firstName: record.userFirstName,
    lastName: record.userLastName,
    gradualUserId: record.userId,
    registrationAnswers,
    registeredAt: record.dateOfRegistration || record.timestamp,
    source: 'gradual_import',
  }

  const eventData: EventData = {
    eventId: event.event_id,
    eventCity: event.city,
    eventCountryCode: event.country_code,
    venueAddress: event.venue_address,
  }

  const regResult = await createFullRegistration(
    supabase,
    registrationData,
    eventData,
    customerioSiteId,
    customerioApiKey
  )

  if (regResult.success) {
    // Update registration with UTM data (not handled by shared library)
    if (regResult.registrationId && (record.utmSource || record.utmMedium || record.utmCampaign || record.utmContent || record.utmTerm || record.referUrl)) {
      const utmUpdate: Record<string, string | null> = {}
      if (record.utmSource) utmUpdate.utm_source = record.utmSource
      if (record.utmMedium) utmUpdate.utm_medium = record.utmMedium
      if (record.utmCampaign) utmUpdate.utm_campaign = record.utmCampaign
      if (record.utmContent) utmUpdate.utm_content = record.utmContent
      if (record.utmTerm) utmUpdate.utm_term = record.utmTerm
      if (record.referUrl) utmUpdate.referrer = record.referUrl

      await supabase
        .from('events_registrations')
        .update(utmUpdate)
        .eq('id', regResult.registrationId)
    }
    result.registrations_created++
  } else {
    result.errors.push({ id: record.id, email: record.userEmail, error: regResult.error || 'Unknown error' })
  }
}

async function processAttendance(
  record: GradualHistoricRecord,
  result: ImportResult
): Promise<void> {
  if (!record.eventSlug) {
    result.errors.push({ id: record.id, email: record.userEmail, error: 'Missing eventSlug' })
    result.skipped++
    return
  }

  const event = await findEventByGradualSlug(record.eventSlug)

  if (!event) {
    // Store as pending attendance
    const pending = await storePendingAttendance(record)
    if (pending) {
      result.attendance_pending++
    } else {
      result.errors.push({ id: record.id, email: record.userEmail, error: 'Failed to store pending attendance' })
    }
    return
  }

  // Find profile
  const memberProfileId = await findProfileByEmail(record.userEmail)

  if (!memberProfileId) {
    // Store as pending - member profile will be created when they register
    const pending = await storePendingAttendance(record)
    if (pending) {
      result.attendance_pending++
    } else {
      result.errors.push({ id: record.id, email: record.userEmail, error: 'No member profile and failed to store pending' })
    }
    return
  }

  const attendance = await createEventAttendance(
    event.id, // Use UUID for event_attendance
    memberProfileId,
    record.timestamp || record.dateOfRegistration || new Date().toISOString()
  )

  if (attendance) {
    result.attendance_created++
  } else {
    result.errors.push({ id: record.id, email: record.userEmail, error: 'Failed to create attendance' })
  }
}

async function processRecord(
  record: GradualHistoricRecord,
  result: ImportResult
): Promise<void> {
  // First, ensure person exists
  const person = await upsertPerson(record)
  if (person) {
    if (person.isNew) {
      result.people_created++
    } else {
      result.people_updated++
    }
  }

  // Process based on type
  switch (record.type) {
    case 'userRegistersForEvent':
      await processRegistration(record, result)
      break
    case 'userAttendsEvent':
      await processAttendance(record, result)
      break
    default:
      result.skipped++
      console.log(`Skipping unknown type: ${record.type}`)
  }

  result.processed++
}

// =============================================================================
// Main Handler
// =============================================================================

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Only POST method is allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  let records: GradualHistoricRecord[]
  try {
    const body = await req.json()
    records = body.records || body
    if (!Array.isArray(records)) {
      return new Response(JSON.stringify({ error: 'Expected array of records' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
  } catch (error) {
    return new Response(JSON.stringify({ error: `Failed to parse JSON: ${error.message}` }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  console.log(`Starting import of ${records.length} records`)

  const result: ImportResult = {
    total: records.length,
    processed: 0,
    registrations_created: 0,
    registrations_pending: 0,
    attendance_created: 0,
    attendance_pending: 0,
    people_created: 0,
    people_updated: 0,
    skipped: 0,
    errors: [],
  }

  // Process records sequentially to avoid overwhelming the database
  for (const record of records) {
    try {
      await processRecord(record, result)
    } catch (error) {
      console.error(`Error processing record ${record.id}:`, error)
      result.errors.push({ id: record.id, email: record.userEmail, error: error.message })
    }

    // Log progress every 100 records
    if (result.processed % 100 === 0) {
      console.log(`Processed ${result.processed}/${result.total} records`)
    }
  }

  console.log(`Import complete: ${JSON.stringify(result)}`)

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
