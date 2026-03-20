import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * Process Calendar CSV Upload
 *
 * This edge function processes calendar member CSV uploads stored in luma_csv_uploads table.
 * It runs in the background after the CSV data is uploaded, processing each row
 * and creating auth users, people, and calendar members as needed.
 *
 * Supports two CSV formats:
 * - Standard format: email, first_name, last_name, membership_type, phone, company
 * - Luma format: user_api_id, email, name, first_name, last_name, first_seen, tags, etc.
 */

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface CalendarCsvUpload {
  id: string
  brand_id: string
  csv_type: 'calendar_members_import'
  csv_data: any[]
  csv_headers: string[]
  calendar_id: string
  uploaded_by_admin_id: string
}

interface CalendarLocation {
  type: 'global' | 'city' | 'region' | 'country'
  city?: string
  state?: string          // US state or equivalent region
  country?: string        // Full country name
  country_code?: string   // ISO 3166-1 alpha-2 code (e.g., 'US', 'GB')
  continent?: string      // Continent name
}

interface ProcessResult {
  processed: number
  errors: Array<{ row: number; error: string }>
  membersCreated: number
}

/**
 * Detect CSV format based on column headers
 */
function detectCsvFormat(headers: string[]): 'standard' | 'luma' {
  const normalizedHeaders = headers.map(h => h.toLowerCase().trim())

  // Luma Calendar Members CSV has 'user_api_id' and 'first_seen'
  if (
    normalizedHeaders.includes('user_api_id') &&
    normalizedHeaders.includes('first_seen')
  ) {
    return 'luma'
  }

  return 'standard'
}

/**
 * Generate a temporary cio_id for people created via import
 * Uses the same format as user-signup: email:<email>
 */
function generateCioId(email: string): string {
  return `email:${email.toLowerCase()}`
}

/**
 * Update person attributes with import data
 */
async function updatePersonAttributes(
  personId: number,
  attributes: {
    first_name?: string
    last_name?: string
    phone?: string
    company?: string
    job_title?: string
    source?: string
    signup_source?: string
    // Location fields
    city?: string
    state?: string
    country?: string
    country_code?: string
    continent?: string
  }
): Promise<void> {
  // Build attributes object, only including non-empty values
  const attrs: Record<string, string> = {}
  if (attributes.first_name?.trim()) attrs.first_name = attributes.first_name.trim()
  if (attributes.last_name?.trim()) attrs.last_name = attributes.last_name.trim()
  if (attributes.phone?.trim()) attrs.phone = attributes.phone.trim()
  if (attributes.company?.trim()) attrs.company = attributes.company.trim()
  if (attributes.job_title?.trim()) attrs.job_title = attributes.job_title.trim()
  if (attributes.source?.trim()) attrs.source = attributes.source.trim()
  if (attributes.signup_source?.trim()) attrs.signup_source = attributes.signup_source.trim()
  // Location fields
  if (attributes.city?.trim()) attrs.city = attributes.city.trim()
  if (attributes.state?.trim()) attrs.state = attributes.state.trim()
  if (attributes.country?.trim()) attrs.country = attributes.country.trim()
  if (attributes.country_code?.trim()) attrs.country_code = attributes.country_code.trim()
  if (attributes.continent?.trim()) attrs.continent = attributes.continent.trim()

  if (Object.keys(attrs).length === 0) {
    return // Nothing to update
  }

  // Get existing attributes
  const { data: person } = await supabase
    .from('people')
    .select('attributes')
    .eq('id', personId)
    .single()

  // Merge with existing attributes (new values take precedence for empty fields only)
  const existingAttrs = (person?.attributes as Record<string, any>) || {}
  const mergedAttrs = { ...existingAttrs }

  // Only set attributes if they don't already exist or are empty
  for (const [key, value] of Object.entries(attrs)) {
    if (!existingAttrs[key] || existingAttrs[key] === '') {
      mergedAttrs[key] = value
    }
  }

  // Update person
  await supabase
    .from('people')
    .update({ attributes: mergedAttrs })
    .eq('id', personId)
}

/**
 * Get calendar location from settings
 * Returns null if calendar has no location or is global
 */
async function getCalendarLocation(calendarId: string): Promise<CalendarLocation | null> {
  const { data: calendar } = await supabase
    .from('calendars')
    .select('settings')
    .eq('id', calendarId)
    .single()

  if (!calendar?.settings?.location) {
    return null
  }

  const location = calendar.settings.location as CalendarLocation

  // Don't return location for global calendars
  if (location.type === 'global') {
    return null
  }

  return location
}

/**
 * Get or create person by email with auth user
 * Creates auth user which triggers person creation via webhook
 */
async function getOrCreatePerson(
  email: string,
  firstName: string | undefined,
  lastName: string | undefined
): Promise<{ id: number } | null> {
  // Check if person already exists
  const { data: existingPerson } = await supabase
    .from('people')
    .select('id')
    .ilike('email', email)
    .maybeSingle()

  if (existingPerson) {
    return existingPerson
  }

  // Build attributes for person creation
  const attributes: Record<string, string> = {}
  if (firstName?.trim()) attributes.first_name = firstName.trim()
  if (lastName?.trim()) attributes.last_name = lastName.trim()

  // Create auth user (this triggers person creation via webhook/trigger)
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: {
      first_name: firstName || null,
      last_name: lastName || null,
    },
  })

  if (authError) {
    console.error(`Auth error for ${email}:`, authError.message)

    // Check if auth user already exists
    const authUserExists = authError.message?.includes('already been registered')

    // Try to get person again (might have been created by concurrent request or webhook)
    const { data: retryPerson } = await supabase
      .from('people')
      .select('id')
      .ilike('email', email)
      .maybeSingle()

    if (retryPerson) {
      return retryPerson
    }

    // If auth user exists but person doesn't, get auth user ID and create person
    if (authUserExists) {
      const { data: authUserId, error: rpcError } = await supabase
        .rpc('get_auth_user_id_by_email', { p_email: email })

      if (rpcError) {
        console.error(`Failed to get auth user ID for ${email}:`, rpcError.message)
      }

      if (authUserId) {
        const { data: newPerson, error: insertError } = await supabase
          .from('people')
          .insert({
            cio_id: generateCioId(email),
            email: email.toLowerCase(),
            auth_user_id: authUserId,
            attributes: Object.keys(attributes).length > 0 ? attributes : null,
          })
          .select('id')
          .single()

        if (insertError) {
          console.error(`Failed to create person for ${email}:`, insertError.message)
          const { data: finalPerson } = await supabase
            .from('people')
            .select('id')
            .ilike('email', email)
            .maybeSingle()

          return finalPerson
        }

        return newPerson
      }
    }

    // Auth failed for other reason - create person without auth link
    console.error(`Creating person without auth link for ${email}`)
    const { data: newPerson, error: insertError } = await supabase
      .from('people')
      .insert({
        cio_id: generateCioId(email),
        email: email.toLowerCase(),
        attributes: Object.keys(attributes).length > 0 ? attributes : null,
      })
      .select('id')
      .single()

    if (insertError) {
      console.error(`Failed to create person for ${email}:`, insertError.message)
      const { data: finalPerson } = await supabase
        .from('people')
        .select('id')
        .ilike('email', email)
        .maybeSingle()

      return finalPerson
    }

    return newPerson
  }

  // Auth user created successfully, poll for person (webhook should create it)
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200))
    const { data: newPerson } = await supabase
      .from('people')
      .select('id')
      .ilike('email', email)
      .maybeSingle()

    if (newPerson) {
      return newPerson
    }
  }

  // Webhook didn't create person in time, create directly with auth link
  const { data: fallbackPerson, error: fallbackError } = await supabase
    .from('people')
    .insert({
      cio_id: generateCioId(email),
      email: email.toLowerCase(),
      auth_user_id: authData.user.id,
      attributes: Object.keys(attributes).length > 0 ? attributes : null,
    })
    .select('id')
    .single()

  if (fallbackError) {
    const { data: finalPerson } = await supabase
      .from('people')
      .select('id')
      .ilike('email', email)
      .maybeSingle()

    return finalPerson
  }

  return fallbackPerson
}

/**
 * Create calendar member entry
 */
async function createCalendarMember(
  calendarId: string,
  customerId: number,
  memberProfileId: string,
  email: string,
  membershipType: 'subscriber' | 'member' | 'vip' | 'organizer' | 'admin',
  importSource: string,
  lumaData?: {
    luma_user_id?: string
    luma_revenue?: string
    luma_event_approved_count?: number
    luma_event_checked_in_count?: number
    luma_membership_name?: string
    luma_membership_status?: string
    luma_tags?: string[]
    first_seen_at?: string
  },
  importMetadata?: Record<string, any>
): Promise<{ success: boolean; isNew: boolean; error?: string }> {
  try {
    // Check if already a member
    const { data: existingMember } = await supabase
      .from('calendars_members')
      .select('id')
      .eq('calendar_id', calendarId)
      .eq('person_id', customerId)
      .maybeSingle()

    if (existingMember) {
      // Update existing member with new data if available
      if (lumaData) {
        await supabase
          .from('calendars_members')
          .update({
            luma_user_id: lumaData.luma_user_id,
            luma_revenue: lumaData.luma_revenue,
            luma_event_approved_count: lumaData.luma_event_approved_count,
            luma_event_checked_in_count: lumaData.luma_event_checked_in_count,
            luma_membership_name: lumaData.luma_membership_name,
            luma_membership_status: lumaData.luma_membership_status,
            luma_tags: lumaData.luma_tags,
            first_seen_at: lumaData.first_seen_at,
          })
          .eq('id', existingMember.id)
      }
      return { success: true, isNew: false }
    }

    // Insert new calendar member
    const insertData: Record<string, any> = {
      calendar_id: calendarId,
      email: email.toLowerCase(),
      person_id: customerId,
      people_profile_id: memberProfileId,
      membership_type: membershipType,
      membership_status: 'active',
      import_source: importSource,
      import_metadata: importMetadata || {},
      joined_at: new Date().toISOString(),
    }

    // Add Luma-specific fields if present
    if (lumaData) {
      if (lumaData.luma_user_id) insertData.luma_user_id = lumaData.luma_user_id
      if (lumaData.luma_revenue) insertData.luma_revenue = lumaData.luma_revenue
      if (lumaData.luma_event_approved_count !== undefined) insertData.luma_event_approved_count = lumaData.luma_event_approved_count
      if (lumaData.luma_event_checked_in_count !== undefined) insertData.luma_event_checked_in_count = lumaData.luma_event_checked_in_count
      if (lumaData.luma_membership_name) insertData.luma_membership_name = lumaData.luma_membership_name
      if (lumaData.luma_membership_status) insertData.luma_membership_status = lumaData.luma_membership_status
      if (lumaData.luma_tags) insertData.luma_tags = lumaData.luma_tags
      if (lumaData.first_seen_at) {
        insertData.first_seen_at = lumaData.first_seen_at
        // Use first_seen_at as joined_at for calendar members imported from Luma
        insertData.joined_at = lumaData.first_seen_at
      }
    }

    const { error: insertError } = await supabase
      .from('calendars_members')
      .insert(insertData)

    if (insertError) {
      if (insertError.code === '23505') {
        // Duplicate - already exists (race condition)
        return { success: true, isNew: false }
      }
      return { success: false, isNew: false, error: insertError.message }
    }

    return { success: true, isNew: true }
  } catch (error: any) {
    return { success: false, isNew: false, error: error.message }
  }
}

/**
 * Process Standard Format CSV rows
 */
async function processStandardFormat(
  upload: CalendarCsvUpload,
  updateProgress: (processed: number, errors: any[], membersCreated: number) => Promise<void>,
  calendarLocation: CalendarLocation | null
): Promise<ProcessResult> {
  const rows = upload.csv_data
  const errors: Array<{ row: number; error: string }> = []
  let processed = upload.processed_rows || 0
  let membersCreated = upload.registrations_created || 0

  // Resume from where we left off
  const startIndex = processed

  // Process in batches with a limit to avoid timeout
  const BATCH_SIZE = 20
  const MAX_ROWS_PER_INVOCATION = 500 // Process max 500 rows per invocation to avoid timeout (was timing out at 760)
  const endIndex = Math.min(startIndex + MAX_ROWS_PER_INVOCATION, rows.length)

  for (let i = startIndex; i < endIndex; i += BATCH_SIZE) {
    const batch = rows.slice(i, Math.min(i + BATCH_SIZE, endIndex))

    const results = await Promise.all(
      batch.map(async (row, batchIndex) => {
        const rowNum = i + batchIndex + 2 // Account for header row and 0-indexing

        try {
          // Validate email
          const email = row.email?.trim()
          if (!email || !email.includes('@')) {
            return { rowNum, success: false, error: 'Invalid or missing email' }
          }

          // Parse name
          let firstName = row.first_name?.trim()
          let lastName = row.last_name?.trim()
          if ((!firstName || !lastName) && row.name) {
            const parts = row.name.trim().split(/\s+/)
            if (parts.length === 1) {
              firstName = firstName || parts[0]
            } else {
              firstName = firstName || parts.slice(0, -1).join(' ')
              lastName = lastName || parts[parts.length - 1]
            }
          }

          // Get or create person
          const person = await getOrCreatePerson(email, firstName, lastName)
          if (!person) {
            return { rowNum, success: false, error: 'Failed to create person' }
          }

          // Update person attributes (including source and location for new people)
          await updatePersonAttributes(person.id, {
            first_name: firstName,
            last_name: lastName,
            phone: row.phone,
            company: row.company,
            source: 'calendar_csv_import',
            signup_source: 'calendar_csv_import',
            // Location from calendar settings (only set if person doesn't have location)
            city: calendarLocation?.city,
            state: calendarLocation?.state,
            country: calendarLocation?.country,
            country_code: calendarLocation?.country_code,
            continent: calendarLocation?.continent,
          })

          // Get or create member profile
          const { data: memberProfileId, error: memberError } = await supabase
            .rpc('people_get_or_create_profile', {
              p_person_id: person.id,
            })

          if (memberError) {
            return { rowNum, success: false, error: `Failed to create member profile: ${memberError.message}` }
          }

          // Parse membership type
          let membershipType: 'subscriber' | 'member' | 'vip' | 'organizer' | 'admin' = 'subscriber'
          if (row.membership_type) {
            const normalizedType = row.membership_type.toLowerCase().trim()
            if (['subscriber', 'member', 'vip', 'organizer', 'admin'].includes(normalizedType)) {
              membershipType = normalizedType as typeof membershipType
            }
          }

          // Create calendar member
          const memberResult = await createCalendarMember(
            upload.calendar_id,
            person.id,
            memberProfileId,
            email,
            membershipType,
            'csv_import',
            undefined,
            {
              first_name: firstName,
              last_name: lastName,
              name: row.name,
              phone: row.phone,
              company: row.company,
            }
          )

          return {
            rowNum,
            success: memberResult.success,
            isNew: memberResult.isNew,
            error: memberResult.error,
          }
        } catch (error: any) {
          return { rowNum, success: false, error: error.message }
        }
      })
    )

    // Process batch results
    for (const result of results) {
      if (result.success) {
        if (result.isNew) {
          membersCreated++
        }
      } else {
        errors.push({ row: result.rowNum, error: result.error || 'Unknown error' })
      }
    }

    processed += batch.length
    await updateProgress(processed, errors, membersCreated)
  }

  return { processed, errors, membersCreated }
}

/**
 * Process Luma Format CSV rows
 */
async function processLumaFormat(
  upload: CalendarCsvUpload,
  updateProgress: (processed: number, errors: any[], membersCreated: number) => Promise<void>,
  calendarLocation: CalendarLocation | null
): Promise<ProcessResult> {
  const rows = upload.csv_data
  const errors: Array<{ row: number; error: string }> = []
  let processed = upload.processed_rows || 0
  let membersCreated = upload.registrations_created || 0

  // Resume from where we left off
  const startIndex = processed

  // Process in batches with a limit to avoid timeout
  const BATCH_SIZE = 20
  const MAX_ROWS_PER_INVOCATION = 500 // Process max 500 rows per invocation to avoid timeout (was timing out at 760)
  const endIndex = Math.min(startIndex + MAX_ROWS_PER_INVOCATION, rows.length)

  for (let i = startIndex; i < endIndex; i += BATCH_SIZE) {
    const batch = rows.slice(i, Math.min(i + BATCH_SIZE, endIndex))

    const results = await Promise.all(
      batch.map(async (row, batchIndex) => {
        const rowNum = i + batchIndex + 2

        try {
          // Validate required fields
          const email = row.email?.trim()
          if (!email || !email.includes('@')) {
            return { rowNum, success: false, error: 'Invalid or missing email' }
          }
          if (!row.user_api_id) {
            return { rowNum, success: false, error: 'Missing user_api_id' }
          }

          // Get or create person
          const person = await getOrCreatePerson(email, row.first_name, row.last_name)
          if (!person) {
            return { rowNum, success: false, error: 'Failed to create person' }
          }

          // Update person attributes (including source and location for new people)
          await updatePersonAttributes(person.id, {
            first_name: row.first_name,
            last_name: row.last_name,
            source: 'luma_calendar_csv_import',
            signup_source: 'luma_calendar_csv_import',
            // Location from calendar settings (only set if person doesn't have location)
            city: calendarLocation?.city,
            state: calendarLocation?.state,
            country: calendarLocation?.country,
            country_code: calendarLocation?.country_code,
            continent: calendarLocation?.continent,
          })

          // Get or create member profile
          const { data: memberProfileId, error: memberError } = await supabase
            .rpc('people_get_or_create_profile', {
              p_person_id: person.id,
            })

          if (memberError) {
            return { rowNum, success: false, error: `Failed to create member profile: ${memberError.message}` }
          }

          // Parse tags
          const tags = row.tags ? row.tags.split(',').map((t: string) => t.trim()) : null

          // Create calendar member with Luma data
          const memberResult = await createCalendarMember(
            upload.calendar_id,
            person.id,
            memberProfileId,
            email,
            'subscriber',
            'luma_csv',
            {
              luma_user_id: row.user_api_id,
              luma_revenue: row.revenue,
              luma_event_approved_count: row.event_approved_count ? parseInt(row.event_approved_count, 10) : 0,
              luma_event_checked_in_count: row.event_checked_in_count ? parseInt(row.event_checked_in_count, 10) : 0,
              luma_membership_name: row.membership_name,
              luma_membership_status: row.membership_status,
              luma_tags: tags,
              first_seen_at: row.first_seen ? new Date(row.first_seen).toISOString() : undefined,
            },
            {
              name: row.name,
              first_name: row.first_name,
              last_name: row.last_name,
              raw_row: row,
            }
          )

          return {
            rowNum,
            success: memberResult.success,
            isNew: memberResult.isNew,
            error: memberResult.error,
          }
        } catch (error: any) {
          return { rowNum, success: false, error: error.message }
        }
      })
    )

    // Process batch results
    for (const result of results) {
      if (result.success) {
        if (result.isNew) {
          membersCreated++
        }
      } else {
        errors.push({ row: result.rowNum, error: result.error || 'Unknown error' })
      }
    }

    processed += batch.length
    await updateProgress(processed, errors, membersCreated)
  }

  return { processed, errors, membersCreated }
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  try {
    const { uploadId } = await req.json()

    if (!uploadId) {
      return new Response(JSON.stringify({ error: 'uploadId is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Fetch the upload record
    const { data: upload, error: fetchError } = await supabase
      .from('integrations_luma_csv_uploads')
      .select('*')
      .eq('id', uploadId)
      .single()

    if (fetchError || !upload) {
      return new Response(JSON.stringify({ error: 'Upload not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Validate this is a calendar members import
    if (upload.csv_type !== 'calendar_members_import') {
      return new Response(JSON.stringify({ error: 'Invalid csv_type - expected calendar_members_import' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Check if already completed
    if (upload.status === 'completed') {
      return new Response(JSON.stringify({
        success: true,
        message: 'Upload already completed',
        processed: upload.processed_rows,
        membersCreated: upload.registrations_created,
        errorCount: upload.error_count,
        hasMoreRows: false,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Mark as processing (or keep processing if already started)
    if (upload.status !== 'processing') {
      await supabase
        .from('integrations_luma_csv_uploads')
        .update({
          status: 'processing',
          processing_started_at: new Date().toISOString(),
        })
        .eq('id', uploadId)
    }

    console.log(`Processing Calendar CSV upload ${uploadId}: ${upload.row_count} rows for calendar ${upload.calendar_id}`)

    // Fetch calendar location for setting person attributes
    const calendarLocation = await getCalendarLocation(upload.calendar_id)
    if (calendarLocation) {
      console.log(`Calendar has location: ${calendarLocation.city || calendarLocation.state || calendarLocation.country || 'unknown'}`)
    }

    // Progress update function
    const updateProgress = async (processed: number, errors: any[], membersCreated: number) => {
      await supabase
        .from('integrations_luma_csv_uploads')
        .update({
          processed_rows: processed,
          error_count: errors.length,
          errors: errors,
          registrations_created: membersCreated, // Reusing this column for member count
        })
        .eq('id', uploadId)
    }

    // Detect format and process
    const format = detectCsvFormat(upload.csv_headers)
    let result: ProcessResult

    if (format === 'luma') {
      result = await processLumaFormat(upload as CalendarCsvUpload, updateProgress, calendarLocation)
    } else {
      result = await processStandardFormat(upload as CalendarCsvUpload, updateProgress, calendarLocation)
    }

    // Check if there are more rows to process
    const hasMoreRows = result.processed < upload.row_count

    if (hasMoreRows) {
      // Still processing - keep status as 'processing' and return
      // Client will trigger next chunk when it sees hasMoreRows: true
      console.log(`Processed ${result.processed}/${upload.row_count} rows, needs continuation...`)

      return new Response(JSON.stringify({
        success: true,
        processed: result.processed,
        membersCreated: result.membersCreated,
        errorCount: result.errors.length,
        hasMoreRows: true,
        uploadId: uploadId, // Include uploadId so client can trigger next chunk
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // All done - mark as completed
    await supabase
      .from('integrations_luma_csv_uploads')
      .update({
        status: result.errors.length > 0 && result.processed === 0 ? 'failed' : 'completed',
        processed_rows: result.processed,
        error_count: result.errors.length,
        errors: result.errors,
        registrations_created: result.membersCreated,
        processing_completed_at: new Date().toISOString(),
      })
      .eq('id', uploadId)

    console.log(`Completed processing upload ${uploadId}: ${result.processed} processed, ${result.membersCreated} members created, ${result.errors.length} errors`)

    return new Response(JSON.stringify({
      success: true,
      processed: result.processed,
      membersCreated: result.membersCreated,
      errorCount: result.errors.length,
      hasMoreRows: false,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error: any) {
    console.error('Error processing Calendar CSV:', error)
    return new Response(JSON.stringify({ error: error.message || 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
