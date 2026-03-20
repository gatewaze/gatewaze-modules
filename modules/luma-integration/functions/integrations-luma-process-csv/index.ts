import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  createFullRegistration,
  parseName,
  type RegistrationData,
  type EventData,
} from '../_shared/lumaRegistration.ts'

/**
 * Process Luma CSV Upload
 *
 * This edge function processes CSV uploads stored in luma_csv_uploads table.
 * It runs in the background after the CSV data is uploaded, processing each row
 * and creating registrations as needed.
 *
 * Uses shared lumaRegistration module for consistent registration handling
 * across email, webhook, and CSV import sources.
 */

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const customerioSiteId = Deno.env.get('CUSTOMERIO_SITE_ID')
const customerioApiKey = Deno.env.get('CUSTOMERIO_API_KEY')

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

interface LumaCsvUpload {
  id: string
  brand_id: string
  csv_type: 'event_guests' | 'calendar_members'
  csv_data: any[]
  csv_headers: string[]
  event_id?: string
  luma_calendar_id?: string
  luma_event_id?: string
  uploaded_by_admin_id: string
}

/**
 * Extract Luma event ID from QR code URL
 */
function extractLumaEventId(qrCodeUrl: string): string | null {
  const match = qrCodeUrl?.match(/evt-[A-Za-z0-9]+/)
  return match ? match[0] : null
}

/**
 * Parse monetary amount from Luma format
 */
function parseAmount(value: string | undefined): number | null {
  if (!value) return null
  const numericStr = value.replace(/[^0-9.-]/g, '')
  const parsed = parseFloat(numericStr)
  return isNaN(parsed) ? null : parsed
}

/**
 * Map country code to full country name
 */
const countryCodeToName: Record<string, string> = {
  'US': 'United States',
  'GB': 'United Kingdom',
  'CA': 'Canada',
  'AU': 'Australia',
  'DE': 'Germany',
  'FR': 'France',
  'ES': 'Spain',
  'IT': 'Italy',
  'NL': 'Netherlands',
  'BE': 'Belgium',
  'CH': 'Switzerland',
  'AT': 'Austria',
  'SE': 'Sweden',
  'NO': 'Norway',
  'DK': 'Denmark',
  'FI': 'Finland',
  'IE': 'Ireland',
  'PT': 'Portugal',
  'PL': 'Poland',
  'CZ': 'Czech Republic',
  'JP': 'Japan',
  'KR': 'South Korea',
  'CN': 'China',
  'IN': 'India',
  'SG': 'Singapore',
  'HK': 'Hong Kong',
  'TW': 'Taiwan',
  'BR': 'Brazil',
  'MX': 'Mexico',
  'AR': 'Argentina',
  'CL': 'Chile',
  'CO': 'Colombia',
  'IL': 'Israel',
  'AE': 'United Arab Emirates',
  'SA': 'Saudi Arabia',
  'ZA': 'South Africa',
  'NZ': 'New Zealand',
}

/**
 * Map region code to continent name
 */
const regionToContinent: Record<string, string> = {
  'na': 'North America',
  'sa': 'South America',
  'eu': 'Europe',
  'as': 'Asia',
  'af': 'Africa',
  'oc': 'Oceania',
  'an': 'Antarctica',
}

// NOTE: Person attribute updates and registration creation are now handled
// by the shared lumaRegistration module (createFullRegistration function)


/**
 * Known Luma CSV columns that are NOT survey questions
 */
const KNOWN_LUMA_COLUMNS = new Set([
  'api_id', 'name', 'first_name', 'last_name', 'email', 'phone_number',
  'created_at', 'approval_status', 'checked_in_at', 'custom_source',
  'qr_code_url', 'amount', 'amount_tax', 'amount_discount', 'currency',
  'coupon_code', 'eth_address', 'solana_address', 'survey_response_rating',
  'survey_response_feedback', 'ticket_type_id', 'ticket_name'
])

/**
 * Extract survey responses from a CSV row
 * Any column not in the known Luma columns is considered a survey question
 */
function extractSurveyResponses(row: Record<string, any>): Record<string, any> {
  const surveyResponses: Record<string, any> = {}

  for (const [key, value] of Object.entries(row)) {
    // Skip known Luma columns
    if (KNOWN_LUMA_COLUMNS.has(key)) continue

    // Skip empty values
    if (!value || value === '' || value === 'No answer provided.') continue

    // This is a survey question - store it
    surveyResponses[key] = value
  }

  return surveyResponses
}

/**
 * Process Event Guests CSV rows - OPTIMIZED with batching
 */
async function processEventGuests(
  upload: LumaCsvUpload,
  updateProgress: (processed: number, errors: any[], registrationsCreated: number) => Promise<void>
) {
  const rows = upload.csv_data
  const errors: Array<{ row: number; error: string }> = []
  let processed = 0
  let registrationsCreated = 0

  // When event_id is provided (CSV uploaded from a specific event), always use it
  // The lumaEventId is only needed for the luma_event_registrations tracking table
  const lumaEventId = upload.luma_event_id || (rows[0]?.qr_code_url ? extractLumaEventId(rows[0].qr_code_url) : null)

  // If no event_id provided and can't extract luma_event_id, we can't proceed
  if (!upload.event_id && !lumaEventId) {
    errors.push({ row: 1, error: 'No event_id provided and could not extract Luma event ID from qr_code_url' })
    await updateProgress(0, errors, 0)
    return { processed: 0, errors, registrationsCreated: 0 }
  }

  // Always use upload.event_id if provided - this is the event the CSV was uploaded from
  let internalEventId = upload.event_id
  let eventCity: string | undefined
  let eventCountryCode: string | undefined
  let eventCountry: string | undefined
  let eventRegion: string | undefined
  let eventContinent: string | undefined
  let eventLocation: string | undefined

  if (internalEventId) {
    // Fetch event location for person attribute backfill
    const { data: event } = await supabase
      .from('events')
      .select('event_city, event_country_code, event_region, event_location')
      .eq('event_id', internalEventId)
      .maybeSingle()

    if (event) {
      eventCity = event.event_city || undefined
      eventCountryCode = event.event_country_code || undefined
      eventCountry = event.event_country_code ? countryCodeToName[event.event_country_code] : undefined
      eventRegion = event.event_region || undefined
      eventContinent = event.event_region ? regionToContinent[event.event_region.toLowerCase()] : undefined
      eventLocation = event.event_location || undefined
    }
  } else {
    const { data: event } = await supabase
      .from('events')
      .select('event_id, event_city, event_country_code, event_region, event_location')
      .eq('luma_event_id', lumaEventId)
      .maybeSingle()

    if (event) {
      internalEventId = event.event_id
      eventCity = event.event_city || undefined
      eventCountryCode = event.event_country_code || undefined
      eventCountry = event.event_country_code ? countryCodeToName[event.event_country_code] : undefined
      eventRegion = event.event_region || undefined
      eventContinent = event.event_region ? regionToContinent[event.event_region.toLowerCase()] : undefined
      eventLocation = event.event_location || undefined
    }
  }

  // BATCH 1: Upsert all luma_event_registrations at once
  const lumaRegBatch = rows
    .filter(row => row.api_id && row.email)
    .map(row => ({
      brand_id: upload.brand_id,
      luma_guest_id: row.api_id,
      luma_event_id: lumaEventId,
      email: row.email,
      name: row.name,
      first_name: row.first_name,
      last_name: row.last_name,
      phone_number: row.phone_number || null,
      luma_approval_status: row.approval_status,
      luma_checked_in_at: row.checked_in_at ? new Date(row.checked_in_at).toISOString() : null,
      luma_qr_code_url: row.qr_code_url,
      luma_custom_source: row.custom_source || null,
      luma_ticket_type_id: row.ticket_type_id || null,
      luma_ticket_name: row.ticket_name || null,
      luma_registered_at: row.created_at ? new Date(row.created_at).toISOString() : null,
      amount: parseAmount(row.amount),
      amount_tax: parseAmount(row.amount_tax),
      amount_discount: parseAmount(row.amount_discount),
      currency: row.currency || null,
      coupon_code: row.coupon_code || null,
      uploaded_by_admin_id: upload.uploaded_by_admin_id,
      raw_csv_row: row,
      status: row.approval_status?.toLowerCase() === 'approved' ? 'pending' : 'skipped',
      skip_reason: row.approval_status?.toLowerCase() !== 'approved'
        ? `approval_status is '${row.approval_status}', not 'approved'`
        : null,
    }))

  // Track rows with missing required fields
  rows.forEach((row, i) => {
    if (!row.api_id || !row.email) {
      errors.push({ row: i + 2, error: 'Missing required field: api_id or email' })
    }
  })

  // Only upsert to luma_event_registrations in auto-match mode (no explicit event_id)
  // When event_id is provided, we're doing a direct import and don't need tracking
  const useTrackingTable = !upload.event_id && lumaEventId
  if (useTrackingTable && lumaRegBatch.length > 0) {
    // Use upsert with ignoreDuplicates to only INSERT new rows, preserving existing status
    // This is critical for resumable processing - we don't want to overwrite 'processed' status
    const { error: batchError } = await supabase
      .from('integrations_luma_event_registrations')
      .upsert(lumaRegBatch, {
        onConflict: 'brand_id,luma_event_id,luma_guest_id',
        ignoreDuplicates: true,
      })

    if (batchError) {
      errors.push({ row: 0, error: `Batch insert error: ${batchError.message}` })
      await updateProgress(0, errors, 0)
      return { processed: 0, errors, registrationsCreated: 0 }
    }

    // Don't mark all as processed yet - we'll update as we create registrations
    // For non-approved rows, they're done; for approved rows, we still need to create registrations
  }

  // If we have an internal event, create registrations for approved guests
  if (internalEventId) {
    // Get all approved rows from the CSV
    const allApprovedRows = rows.filter(row =>
      row.api_id && row.email &&
      row.approval_status?.toLowerCase() === 'approved'
    )

    // Determine which rows need processing
    let approvedRows: typeof allApprovedRows
    let alreadyProcessed = 0

    // When event_id is explicitly provided (CSV uploaded from a specific event page),
    // bypass luma_event_registrations tracking and process all rows directly.
    // This ensures the CSV imports into the selected event regardless of luma_event_id.
    if (upload.event_id) {
      // Direct import mode - process all approved rows
      approvedRows = allApprovedRows
      console.log(`Direct import to event ${upload.event_id}: processing ${approvedRows.length} approved rows`)
    } else if (lumaEventId) {
      // Auto-match mode - use luma_event_registrations for resumable processing
      // ORPHAN DETECTION: Find records marked as 'processed' but whose registration was deleted or never created
      const { data: processedRegs } = await supabase
        .from('integrations_luma_event_registrations')
        .select('id, created_registration_id')
        .eq('brand_id', upload.brand_id)
        .eq('luma_event_id', lumaEventId)
        .eq('status', 'processed')

      if (processedRegs && processedRegs.length > 0) {
        // Records with NULL created_registration_id are orphans (never actually created)
        const nullRegIds = processedRegs
          .filter(r => !r.created_registration_id)
          .map(r => r.id)

        // Records with non-null created_registration_id need to be checked if they still exist
        const regsWithIds = processedRegs.filter(r => r.created_registration_id)
        let deletedRegIds: string[] = []

        if (regsWithIds.length > 0) {
          const regIds = regsWithIds.map(r => r.created_registration_id).filter(Boolean)
          const { data: existingRegs } = await supabase
            .from('events_registrations')
            .select('id')
            .in('id', regIds)

          const existingRegIds = new Set(existingRegs?.map(r => r.id) || [])
          deletedRegIds = regsWithIds
            .filter(r => r.created_registration_id && !existingRegIds.has(r.created_registration_id))
            .map(r => r.id)
        }

        const orphanedIds = [...nullRegIds, ...deletedRegIds]

        if (orphanedIds.length > 0) {
          console.log(`Resetting ${orphanedIds.length} orphaned luma_event_registrations to pending (${nullRegIds.length} null, ${deletedRegIds.length} deleted)`)
          await supabase
            .from('integrations_luma_event_registrations')
            .update({
              status: 'pending',
              created_registration_id: null,
              created_person_id: null,
              created_people_profile_id: null,
              processed_at: null,
            })
            .in('id', orphanedIds)
        }
      }

      // Query for pending rows to enable resumable processing
      const { data: pendingRegs, error: pendingError } = await supabase
        .from('integrations_luma_event_registrations')
        .select('email, luma_guest_id')
        .eq('brand_id', upload.brand_id)
        .eq('luma_event_id', lumaEventId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })

      if (pendingError) {
        console.error('Error fetching pending registrations:', pendingError)
      }

      const pendingEmails = new Set(pendingRegs?.map(r => r.email.toLowerCase()) || [])
      approvedRows = allApprovedRows.filter(row => pendingEmails.has(row.email.toLowerCase()))
      alreadyProcessed = allApprovedRows.length - approvedRows.length
    } else {
      // No event_id and no lumaEventId - shouldn't happen due to earlier check
      approvedRows = allApprovedRows
      console.log(`Fallback: processing ${approvedRows.length} approved rows`)
    }

    const nonApprovedCount = lumaRegBatch.length - allApprovedRows.length

    // Start with non-approved rows + already processed as "processed"
    processed = nonApprovedCount + alreadyProcessed
    registrationsCreated = alreadyProcessed // Already created from previous run
    await updateProgress(processed, errors, registrationsCreated)

    console.log(`Resumable processing: ${approvedRows.length} pending, ${alreadyProcessed} already processed, ${nonApprovedCount} non-approved`)

    // Look up per-event marketing consent setting
    let registrantMarketingConsent = false
    if (internalEventId) {
      const { data: commSettings } = await supabase
        .from('events_communication_settings')
        .select('registrant_marketing_consent')
        .eq('event_id', internalEventId)
        .maybeSingle()
      registrantMarketingConsent = commSettings?.registrant_marketing_consent === true
    }

    // Build event data for shared registration function
    const eventData: EventData = {
      eventId: internalEventId!,
      eventCity: eventCity || null,
      eventCountryCode: eventCountryCode || null,
      eventCountry: eventCountry || null,
      eventRegion: eventRegion || null,
      eventContinent: eventContinent || null,
      eventLocation: eventLocation || null,
    }

    // Process in smaller batches for registration creation
    const BATCH_SIZE = 20
    for (let i = 0; i < approvedRows.length; i += BATCH_SIZE) {
      const batch = approvedRows.slice(i, i + BATCH_SIZE)

      // Process batch concurrently using shared createFullRegistration
      const results = await Promise.all(
        batch.map(async (row) => {
          try {
            // Parse name using shared utility
            let firstName = row.first_name
            let lastName = row.last_name
            if ((!firstName || !lastName) && row.name) {
              const parsed = parseName(row.name)
              firstName = firstName || parsed.firstName
              lastName = lastName || parsed.lastName
            }

            // Parse custom_source to extract tracking session ID
            // Format: {platform}__{session_id} e.g. "meta__ml5ddyhn-0er7obxy"
            let csvTrackingSessionId: string | undefined
            if (row.custom_source?.includes('__')) {
              csvTrackingSessionId = row.custom_source.split('__')[1]
            }

            // Build registration data for shared function
            const registrationData: RegistrationData = {
              email: row.email,
              firstName,
              lastName,
              fullName: row.name,
              phone: row.phone_number,
              lumaGuestId: row.api_id,
              ticketType: row.ticket_name || null,
              amountInDollars: parseAmount(row.amount), // CSV has dollars, not cents
              currency: row.currency || null,
              couponCode: row.coupon_code || null,
              surveyResponses: extractSurveyResponses(row),
              externalQrCode: row.qr_code_url,
              registeredAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
              source: 'luma_csv_upload',
              trackingSessionId: csvTrackingSessionId,
            }

            // Use shared registration function
            const regResult = await createFullRegistration(
              supabase,
              registrationData,
              eventData,
              customerioSiteId,
              customerioApiKey,
              registrantMarketingConsent
            )

            return {
              email: row.email,
              success: regResult.success,
              error: regResult.error,
              personId: regResult.personId,
              memberProfileId: regResult.memberProfileId,
              registrationId: regResult.registrationId,
            }
          } catch (error: any) {
            return { email: row.email, success: false, error: error.message }
          }
        })
      )

      // Update luma_event_registrations with results (only in auto-match mode, not direct import)
      // In direct import mode (upload.event_id provided), we skip tracking updates
      const useTracking = !upload.event_id && lumaEventId

      for (const result of results) {
        if (result.success) {
          registrationsCreated++
          if (useTracking) {
            await supabase
              .from('integrations_luma_event_registrations')
              .update({
                status: 'processed',
                processed_at: new Date().toISOString(),
                created_person_id: result.personId,
                created_people_profile_id: result.memberProfileId,
                created_registration_id: result.registrationId,
              })
              .eq('brand_id', upload.brand_id)
              .eq('luma_event_id', lumaEventId)
              .eq('email', result.email)
          }

          // Conversion tracking is now handled by the DB trigger on event_registrations INSERT
          // (send_conversion_on_registration) — tracking_session_id is stored in registration_metadata
        } else {
          if (useTracking) {
            await supabase
              .from('integrations_luma_event_registrations')
              .update({
                status: 'skipped',
                skip_reason: result.error,
              })
              .eq('brand_id', upload.brand_id)
              .eq('luma_event_id', lumaEventId)
              .eq('email', result.email)
          }
        }
      }

      // Update progress after each batch - increment processed by batch size
      processed += batch.length
      await updateProgress(processed, errors, registrationsCreated)
    }
  } else {
    // No internal event - mark all as processed
    processed = lumaRegBatch.length
    await updateProgress(processed, errors, 0)
  }

  return { processed, errors, registrationsCreated }
}

/**
 * Process Calendar Members CSV rows - OPTIMIZED with chunked batching
 * Processes in smaller batches to avoid memory limits on large CSVs
 */
async function processCalendarMembers(
  upload: LumaCsvUpload,
  updateProgress: (processed: number, errors: any[], registrationsCreated: number) => Promise<void>
) {
  const rows = upload.csv_data
  const errors: Array<{ row: number; error: string }> = []

  // Track rows with missing required fields
  rows.forEach((row, i) => {
    if (!row.user_api_id || !row.email) {
      errors.push({ row: i + 2, error: 'Missing required field: user_api_id or email' })
    }
  })

  // Filter valid rows
  const validRows = rows.filter(row => row.user_api_id && row.email)

  let processed = 0

  // Process in chunks of 500 to avoid memory/payload limits
  const CHUNK_SIZE = 500
  for (let i = 0; i < validRows.length; i += CHUNK_SIZE) {
    const chunk = validRows.slice(i, i + CHUNK_SIZE)

    const memberBatch = chunk.map(row => ({
      brand_id: upload.brand_id,
      luma_user_id: row.user_api_id,
      luma_calendar_id: upload.luma_calendar_id || null,
      email: row.email,
      name: row.name,
      first_name: row.first_name,
      last_name: row.last_name,
      first_seen_at: row.first_seen ? new Date(row.first_seen).toISOString() : null,
      tags: row.tags ? row.tags.split(',').map((t: string) => t.trim()) : null,
      revenue: row.revenue || null,
      event_approved_count: row.event_approved_count ? parseInt(row.event_approved_count, 10) : 0,
      event_checked_in_count: row.event_checked_in_count ? parseInt(row.event_checked_in_count, 10) : 0,
      membership_name: row.membership_name || null,
      membership_status: row.membership_status || null,
      uploaded_by_admin_id: upload.uploaded_by_admin_id,
      // Skip raw_csv_row to reduce payload size for large imports
    }))

    const { error: batchError } = await supabase
      .from('integrations_luma_calendar_members')
      .upsert(memberBatch, {
        onConflict: 'brand_id,luma_user_id',
      })

    if (batchError) {
      errors.push({ row: i + 2, error: `Batch insert error at chunk ${Math.floor(i / CHUNK_SIZE) + 1}: ${batchError.message}` })
      // Continue processing other chunks even if one fails
    } else {
      processed += chunk.length
    }

    // Update progress after each chunk
    await updateProgress(processed, errors, 0)
  }

  // After uploading calendar members, try to match pending registrations
  const matchedCount = await matchPendingRegistrations(upload.brand_id)

  return { processed, errors, registrationsCreated: matchedCount }
}

/**
 * Match pending registrations with calendar members
 */
async function matchPendingRegistrations(brandId: string): Promise<number> {
  let matchedCount = 0

  const { data: pendingRegs } = await supabase
    .from('integrations_luma_pending_registrations')
    .select('*')
    .eq('brand_id', brandId)
    .eq('status', 'pending')

  if (!pendingRegs || pendingRegs.length === 0) {
    return 0
  }

  for (const pending of pendingRegs) {
    const { data: member } = await supabase
      .from('integrations_luma_calendar_members')
      .select('email, name, first_name, last_name')
      .eq('brand_id', brandId)
      .eq('luma_user_id', pending.luma_user_id)
      .maybeSingle()

    if (!member) continue

    const { data: event } = await supabase
      .from('events')
      .select('event_id')
      .eq('luma_event_id', pending.luma_event_id)
      .maybeSingle()

    if (!event) {
      await supabase
        .from('integrations_luma_pending_registrations')
        .update({
          status: 'no_event',
          matched_email: member.email,
          matched_via: 'calendar_member',
          matched_at: new Date().toISOString(),
          error_message: `No event found with luma_event_id: ${pending.luma_event_id}`,
        })
        .eq('id', pending.id)
      continue
    }

    // Parse name using shared utility
    let firstName = member.first_name
    let lastName = member.last_name
    if ((!firstName || !lastName) && member.name) {
      const parsed = parseName(member.name)
      firstName = firstName || parsed.firstName
      lastName = lastName || parsed.lastName
    }

    // Build registration data for shared function
    const registrationData: RegistrationData = {
      email: member.email,
      firstName,
      lastName,
      fullName: member.name,
      lumaUserId: pending.luma_user_id,
      source: 'luma_csv_upload',
    }

    const eventData: EventData = {
      eventId: event.event_id,
    }

    // Look up per-event marketing consent setting for this event
    const { data: pendingCommSettings } = await supabase
      .from('events_communication_settings')
      .select('registrant_marketing_consent')
      .eq('event_id', event.event_id)
      .maybeSingle()
    const pendingMarketingConsent = pendingCommSettings?.registrant_marketing_consent === true

    // Use shared registration function
    const regResult = await createFullRegistration(
      supabase,
      registrationData,
      eventData,
      customerioSiteId,
      customerioApiKey,
      pendingMarketingConsent
    )

    if (regResult.success) {
      matchedCount++
      await supabase
        .from('integrations_luma_pending_registrations')
        .update({
          status: 'processed',
          matched_email: member.email,
          matched_via: 'calendar_member',
          matched_at: new Date().toISOString(),
          processed_at: new Date().toISOString(),
          created_person_id: regResult.personId,
          created_people_profile_id: regResult.memberProfileId,
          created_registration_id: regResult.registrationId,
        })
        .eq('id', pending.id)
    } else {
      await supabase
        .from('integrations_luma_pending_registrations')
        .update({
          status: 'failed',
          matched_email: member.email,
          matched_via: 'calendar_member',
          matched_at: new Date().toISOString(),
          error_message: regResult.error,
        })
        .eq('id', pending.id)
    }
  }

  return matchedCount
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

    // Check if already processing or completed
    if (upload.status === 'processing') {
      return new Response(JSON.stringify({ error: 'Upload is already being processed' }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (upload.status === 'completed') {
      return new Response(JSON.stringify({ message: 'Upload already completed', upload }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Mark as processing
    await supabase
      .from('integrations_luma_csv_uploads')
      .update({
        status: 'processing',
        processing_started_at: new Date().toISOString(),
      })
      .eq('id', uploadId)

    console.log(`Processing Luma CSV upload ${uploadId}: ${upload.csv_type} with ${upload.row_count} rows`)

    // Progress update function
    const updateProgress = async (processed: number, errors: any[], registrationsCreated: number) => {
      await supabase
        .from('integrations_luma_csv_uploads')
        .update({
          processed_rows: processed,
          error_count: errors.length,
          errors: errors,
          registrations_created: registrationsCreated,
        })
        .eq('id', uploadId)
    }

    // Process based on CSV type
    let result: { processed: number; errors: any[]; registrationsCreated: number }

    if (upload.csv_type === 'event_guests') {
      result = await processEventGuests(upload as LumaCsvUpload, updateProgress)
    } else {
      result = await processCalendarMembers(upload as LumaCsvUpload, updateProgress)
    }

    // Mark as completed
    await supabase
      .from('integrations_luma_csv_uploads')
      .update({
        status: result.errors.length > 0 && result.processed === 0 ? 'failed' : 'completed',
        processed_rows: result.processed,
        error_count: result.errors.length,
        errors: result.errors,
        registrations_created: result.registrationsCreated,
        processing_completed_at: new Date().toISOString(),
      })
      .eq('id', uploadId)

    console.log(`Completed processing upload ${uploadId}: ${result.processed} processed, ${result.registrationsCreated} registrations created, ${result.errors.length} errors`)

    return new Response(JSON.stringify({
      success: true,
      processed: result.processed,
      registrationsCreated: result.registrationsCreated,
      errorCount: result.errors.length,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error: any) {
    console.error('Error processing Luma CSV:', error)
    return new Response(JSON.stringify({ error: error.message || 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
