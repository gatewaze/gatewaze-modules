import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Gradual API configuration
const GRADUAL_API_BASE_URL = 'https://api.gradual-api.com/public-api/v1'
const GRADUAL_CLIENT_ID = Deno.env.get('GRADUAL_CLIENT_ID') || ''
const GRADUAL_BEARER_TOKEN = Deno.env.get('GRADUAL_BEARER_TOKEN') || ''

// Supabase configuration
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// Batch sync configuration
const BATCH_LIMIT = 40 // registrations per invocation (~2.2s each = ~88s, within 150s timeout)
const GRADUAL_API_DELAY = 1100 // ms between Gradual API calls (their limit: 1 req/sec)
const MAX_RETRIES = 3 // retries for 429 rate limit responses
const PROGRESS_UPDATE_INTERVAL = 10 // update job progress every N registrations

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface UserPayload {
  email: string
  first_name?: string
  last_name?: string
  job_title?: string
  company?: string
  linkedin_url?: string
}

interface GradualUserData {
  email: string
  firstName?: string
  lastName?: string
  company?: string
  position?: string
  linkedInUrl?: string
}

interface EventRegistrationPayload {
  email: string
  event: string
  registrationId?: string
  mode?: string
}

interface BatchSyncPayload {
  mode: 'batch_sync'
  jobId: string
}

interface GradualUserResponse {
  userEmail?: string
  userFirstName?: string
  userLastName?: string
  userCompany?: string
  userTitle?: string
  userLinkedIn?: string
  [key: string]: unknown
}

interface SyncError {
  registrationId: string
  email: string
  error: string
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Call Gradual API with rate limit handling and retries for 429s
 */
async function gradualFetch(
  url: string,
  options: RequestInit,
  retries = MAX_RETRIES
): Promise<{ data: Record<string, unknown>; status: number }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, options)

    if (response.status === 429 && attempt < retries) {
      // Parse retry-after from response, default to 10s
      let retryAfter = 10
      try {
        const body = await response.json()
        const match = body?.message?.match(/(\d+)\s*seconds/)
        if (match) retryAfter = parseInt(match[1], 10)
      } catch { /* ignore parse errors */ }

      console.log(`429 rate limited, waiting ${retryAfter}s before retry ${attempt + 1}/${retries}`)
      await delay(retryAfter * 1000)
      continue
    }

    const data = await response.json()
    return { data, status: response.status }
  }

  return { data: { error: 'Max retries exceeded for rate limit' }, status: 429 }
}

/**
 * Get Gradual API headers
 */
function getGradualHeaders(): Record<string, string> {
  return {
    'x-client-id': GRADUAL_CLIENT_ID,
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${GRADUAL_BEARER_TOKEN}`,
  }
}

/**
 * Transform incoming payload to match Gradual API format
 */
function transformPayloadForGradual(payload: UserPayload): GradualUserData {
  const getValueOrDefault = (value: string | undefined): string | undefined => {
    const trimmed = (value || '').trim()
    // Gradual rejects short company/position names — require at least 2 chars
    // Also reject common placeholder values
    if (!trimmed || trimmed.length < 2 || ['--', '—', 'n/a', 'na', 'none', '..'].includes(trimmed.toLowerCase())) return undefined
    return trimmed
  }

  const gradualData: GradualUserData = {
    email: payload.email,
    firstName: getValueOrDefault(payload.first_name),
    lastName: getValueOrDefault(payload.last_name),
    company: getValueOrDefault(payload.company),
    position: getValueOrDefault(payload.job_title),
  }

  // LinkedIn is optional - only include if valid
  let linkedinUrl = (payload.linkedin_url || '').trim()
  if (linkedinUrl) {
    // Fix double-protocol URLs like "https://HTTP://www.linkedin.com/..."
    linkedinUrl = linkedinUrl.replace(/^https?:\/\/https?:\/\//i, 'https://')
    // Only include if it looks like a valid LinkedIn URL
    if (linkedinUrl.includes('linkedin.com/')) {
      gradualData.linkedInUrl = linkedinUrl
    }
  }

  return gradualData
}

/**
 * Create a user in Gradual API
 */
async function createUserInGradual(
  userData: GradualUserData
): Promise<{ data: GradualUserResponse; status: number }> {
  const url = `${GRADUAL_API_BASE_URL}/users`

  try {
    const result = await gradualFetch(url, {
      method: 'POST',
      headers: getGradualHeaders(),
      body: JSON.stringify(userData),
    })
    return { data: result.data as GradualUserResponse, status: result.status }
  } catch (error) {
    console.error('Error creating user in Gradual:', error)
    return { data: { error: `Request failed: ${error.message}` } as GradualUserResponse, status: 500 }
  }
}

/**
 * Update a user in Gradual API
 */
async function updateUserInGradual(
  userData: GradualUserData
): Promise<{ data: GradualUserResponse; status: number }> {
  const url = `${GRADUAL_API_BASE_URL}/updateProfileByEmail`

  try {
    const result = await gradualFetch(url, {
      method: 'POST',
      headers: getGradualHeaders(),
      body: JSON.stringify(userData),
    })
    return { data: result.data as GradualUserResponse, status: result.status }
  } catch (error) {
    console.error('Error updating user in Gradual:', error)
    return { data: { error: `Request failed: ${error.message}` } as GradualUserResponse, status: 500 }
  }
}

/**
 * Register a user for an event in Gradual API
 */
async function registerUserForEvent(
  userData: GradualUserData,
  eventSlug: string
): Promise<{ data: unknown; status: number }> {
  const url = `${GRADUAL_API_BASE_URL}/registration`

  const registrationData: Record<string, string> = {
    email: userData.email,
    eventSlug: eventSlug,
  }
  if (userData.firstName) registrationData.firstName = userData.firstName
  if (userData.lastName) registrationData.lastName = userData.lastName
  if (userData.company) registrationData.company = userData.company
  if (userData.position) registrationData.position = userData.position

  try {
    return await gradualFetch(url, {
      method: 'POST',
      headers: getGradualHeaders(),
      body: JSON.stringify(registrationData),
    })
  } catch (error) {
    console.error('Error registering user for event in Gradual:', error)
    return { data: { error: `Request failed: ${error.message}` }, status: 500 }
  }
}

/**
 * Check if user data needs to be updated
 */
function needsUpdate(originalData: GradualUserData, responseData: GradualUserResponse): boolean {
  const fieldMapping: Record<string, string> = {
    firstName: 'userFirstName',
    lastName: 'userLastName',
    company: 'userCompany',
    position: 'userTitle',
  }

  for (const [requestField, responseField] of Object.entries(fieldMapping)) {
    const ourValue = originalData[requestField as keyof GradualUserData]
    // Only compare if we have a value to send — don't trigger update for undefined fields
    if (ourValue && ourValue !== responseData[responseField]) {
      return true
    }
  }

  // Handle LinkedIn field separately since it's optional
  if (originalData.linkedInUrl) {
    if (originalData.linkedInUrl !== responseData.userLinkedIn) {
      return true
    }
  }

  return false
}

/**
 * Sync a single registration to Gradual and mark as synced
 */
async function syncSingleRegistration(
  email: string,
  eventSlug: string,
  userPayload?: UserPayload
): Promise<{ success: boolean; error?: string; createResponse?: GradualUserResponse }> {
  // Build user data - use provided payload or minimal with just email
  const payload: UserPayload = userPayload || {
    email,
    first_name: '',
    last_name: '',
    job_title: '',
    company: '',
    linkedin_url: '',
  }

  const gradualUserData = transformPayloadForGradual(payload)

  // Step 1: Create/get user in Gradual
  const { data: createResponse, status: createStatus } = await createUserInGradual(gradualUserData)

  if (createStatus !== 200) {
    return { success: false, error: `User create failed (${createStatus}): ${JSON.stringify(createResponse)}` }
  }

  // Rate limit: wait before next Gradual API call
  await delay(GRADUAL_API_DELAY)

  // Step 2: Build event registration data from response
  const eventUserData: GradualUserData = {
    email: createResponse.userEmail || email,
    firstName: createResponse.userFirstName || undefined,
    lastName: createResponse.userLastName || undefined,
    company: createResponse.userCompany || undefined,
    position: createResponse.userTitle || undefined,
  }

  if (createResponse.userLinkedIn) {
    eventUserData.linkedInUrl = createResponse.userLinkedIn
  }

  // Step 3: Register for event
  const { data: regResponse, status: regStatus } = await registerUserForEvent(eventUserData, eventSlug)

  if (regStatus !== 200) {
    // Treat "already registered" as success
    const regMsg = (regResponse as Record<string, unknown>)?.message as string || ''
    if (regMsg.includes('already_registered')) {
      return { success: true, createResponse }
    }
    return {
      success: false,
      error: `Registration failed (${regStatus}): ${JSON.stringify(regResponse)}`,
      createResponse,
    }
  }

  return { success: true, createResponse }
}

/**
 * Mark a registration as synced to Gradual
 */
async function markRegistrationSynced(registrationId: string): Promise<void> {
  const { error } = await supabase
    .from('events_registrations')
    .update({ gradual_synced_at: new Date().toISOString() })
    .eq('id', registrationId)

  if (error) {
    console.error(`Failed to mark registration ${registrationId} as synced:`, error)
  }
}

/**
 * Handle event registration via PATCH method or mode: 'register_single'
 */
async function handleEventRegistration(requestData: EventRegistrationPayload): Promise<Response> {
  const email = (requestData.email || '').trim()
  const eventSlug = (requestData.event || '').trim()
  const registrationId = requestData.registrationId

  if (!email) {
    return new Response(JSON.stringify({ error: 'Missing required field: email' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (!eventSlug) {
    return new Response(JSON.stringify({ error: 'Missing required field: event' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Step 1: Look up registrant's profile data from the database
  let userPayload: UserPayload = {
    email: email,
    first_name: '',
    last_name: '',
    job_title: '',
    company: '',
    linkedin_url: '',
  }

  if (registrationId) {
    const { data: regData } = await supabase
      .from('events_registrations_with_people')
      .select('first_name, last_name, company, job_title, linkedin_url')
      .eq('id', registrationId)
      .maybeSingle()

    if (regData) {
      userPayload = {
        email,
        first_name: regData.first_name || '',
        last_name: regData.last_name || '',
        job_title: regData.job_title || '',
        company: regData.company || '',
        linkedin_url: regData.linkedin_url || '',
      }
      console.log(`Loaded profile data for registration ${registrationId}: ${userPayload.first_name} ${userPayload.last_name} @ ${userPayload.company}`)
    } else {
      console.log(`No profile data found for registration ${registrationId}, proceeding with email only`)
    }
  }

  const gradualUserData = transformPayloadForGradual(userPayload)

  // Step 2: Try to create user (this will return existing user if already exists)
  const { data: createResponse, status: createStatus } = await createUserInGradual(gradualUserData)

  if (createStatus !== 200) {
    return new Response(
      JSON.stringify({
        error: 'Failed to create/fetch user for event registration',
        details: createResponse,
      }),
      {
        status: createStatus,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Rate limit: wait before next Gradual API call
  await delay(GRADUAL_API_DELAY)

  // Step 3: Prepare user data for event registration using response data
  const eventUserData: GradualUserData = {
    email: createResponse.userEmail || email,
    firstName: createResponse.userFirstName || undefined,
    lastName: createResponse.userLastName || undefined,
    company: createResponse.userCompany || undefined,
    position: createResponse.userTitle || undefined,
  }

  if (createResponse.userLinkedIn) {
    eventUserData.linkedInUrl = createResponse.userLinkedIn
  }

  // Step 4: Register user for event
  const { data: registrationResponse, status: registrationStatus } = await registerUserForEvent(
    eventUserData,
    eventSlug
  )

  if (registrationStatus !== 200) {
    return new Response(
      JSON.stringify({
        error: 'Failed to register user for event',
        user_data: createResponse,
        registration_error: registrationResponse,
      }),
      {
        status: registrationStatus,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Step 5: Mark registration as synced if registrationId provided
  if (registrationId) {
    await markRegistrationSynced(registrationId)
  }

  // Success
  return new Response(
    JSON.stringify({
      message: 'User successfully registered for event',
      user_data: createResponse,
      registration_response: registrationResponse,
      event_slug: eventSlug,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  )
}

/**
 * Handle batch sync of registrations to Gradual
 */
async function handleBatchSync(jobId: string): Promise<Response> {
  // 1. Fetch job
  const { data: job, error: jobError } = await supabase
    .from('integrations_gradual_sync_jobs')
    .select('*')
    .eq('id', jobId)
    .single()

  if (jobError || !job) {
    return new Response(JSON.stringify({ error: 'Job not found', details: jobError }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (job.status === 'completed' || job.status === 'cancelled') {
    return new Response(JSON.stringify({ message: `Job already ${job.status}` }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // 2. Mark as processing
  await supabase
    .from('integrations_gradual_sync_jobs')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', jobId)

  // 3. Get event's gradual slug
  const { data: event } = await supabase
    .from('events')
    .select('gradual_eventslug')
    .eq('event_id', job.event_id)
    .single()

  if (!event?.gradual_eventslug) {
    await supabase
      .from('integrations_gradual_sync_jobs')
      .update({
        status: 'failed',
        errors: [{ error: 'Event has no gradual_eventslug configured' }],
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)

    return new Response(JSON.stringify({ error: 'Event has no gradual_eventslug' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const eventSlug = event.gradual_eventslug

  // 4. Query unsynced registrations
  const { data: registrations, error: regError } = await supabase
    .from('events_registrations_with_people')
    .select('id, email, first_name, last_name, company, job_title, linkedin_url')
    .eq('event_id', job.event_id)
    .eq('status', 'confirmed')
    .is('gradual_synced_at', null)
    .order('id', { ascending: true })
    .limit(BATCH_LIMIT)

  if (regError) {
    console.error('Error fetching registrations:', regError)
    await supabase
      .from('integrations_gradual_sync_jobs')
      .update({
        status: 'failed',
        errors: [{ error: `Failed to fetch registrations: ${regError.message}` }],
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)

    return new Response(JSON.stringify({ error: 'Failed to fetch registrations', details: regError }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (!registrations || registrations.length === 0) {
    await supabase
      .from('integrations_gradual_sync_jobs')
      .update({
        status: 'completed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)

    return new Response(JSON.stringify({ message: 'No unsynced registrations found', processed: 0 }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // 5. Process registrations sequentially
  let processed = job.processed_registrations || 0
  let successful = job.successful_syncs || 0
  let failed = job.failed_syncs || 0
  const errors: SyncError[] = Array.isArray(job.errors) ? [...job.errors] : []

  for (let i = 0; i < registrations.length; i++) {
    // Check if job was cancelled
    if (i > 0 && i % 50 === 0) {
      const { data: currentJob } = await supabase
        .from('integrations_gradual_sync_jobs')
        .select('status')
        .eq('id', jobId)
        .single()

      if (currentJob?.status === 'cancelled') {
        console.log(`Job ${jobId} was cancelled, stopping`)
        break
      }
    }

    const reg = registrations[i]

    try {
      const userPayload: UserPayload = {
        email: reg.email,
        first_name: reg.first_name || '',
        last_name: reg.last_name || '',
        job_title: reg.job_title || '',
        company: reg.company || '',
        linkedin_url: reg.linkedin_url || '',
      }

      const result = await syncSingleRegistration(reg.email, eventSlug, userPayload)

      if (result.success) {
        await markRegistrationSynced(reg.id)
        successful++
      } else {
        errors.push({ registrationId: reg.id, email: reg.email, error: result.error || 'Unknown error' })
        failed++
        console.error(`Failed to sync registration ${reg.id} (${reg.email}):`, result.error)
      }
    } catch (err) {
      errors.push({ registrationId: reg.id, email: reg.email, error: err.message || 'Unexpected error' })
      failed++
      console.error(`Exception syncing registration ${reg.id}:`, err)
    }

    processed++

    // Update progress periodically
    if ((i + 1) % PROGRESS_UPDATE_INTERVAL === 0 || i === registrations.length - 1) {
      await supabase
        .from('integrations_gradual_sync_jobs')
        .update({
          processed_registrations: processed,
          successful_syncs: successful,
          failed_syncs: failed,
          errors: errors.slice(-50), // keep last 50 errors
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
    }

    // Rate limiting: wait before next registration's API call
    if (i < registrations.length - 1) {
      await delay(GRADUAL_API_DELAY)
    }
  }

  // 6. Check if more registrations remain
  const { count: remaining } = await supabase
    .from('events_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', job.event_id)
    .eq('status', 'confirmed')
    .is('gradual_synced_at', null)

  if (remaining && remaining > 0) {
    // Update total and continue processing
    await supabase
      .from('integrations_gradual_sync_jobs')
      .update({
        total_registrations: processed + remaining,
        processed_registrations: processed,
        successful_syncs: successful,
        failed_syncs: failed,
        errors: errors.slice(-50),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)

    // Self-invoke for next batch (fire-and-forget)
    console.log(`Job ${jobId}: ${remaining} registrations remaining, chaining next batch`)
    fetch(`${SUPABASE_URL}/functions/v1/gradual-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ mode: 'batch_sync', jobId }),
    }).catch((err) => console.error('Failed to chain next batch:', err))

    return new Response(
      JSON.stringify({
        message: 'Batch processed, continuing with next batch',
        processed,
        successful,
        failed,
        remaining,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // All done
  await supabase
    .from('integrations_gradual_sync_jobs')
    .update({
      status: 'completed',
      processed_registrations: processed,
      successful_syncs: successful,
      failed_syncs: failed,
      errors: errors.slice(-50),
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)

  console.log(`Job ${jobId} completed: ${successful} successful, ${failed} failed out of ${processed} processed`)

  return new Response(
    JSON.stringify({
      message: 'Batch sync completed',
      processed,
      successful,
      failed,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

/**
 * Handle user creation/update via POST method
 */
async function handleUserSync(requestData: UserPayload): Promise<Response> {
  const email = (requestData.email || '').trim()

  if (!email) {
    return new Response(JSON.stringify({ error: 'Missing required field: email' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Transform payload for Gradual API
  const gradualData = transformPayloadForGradual(requestData)

  // Step 1: Try to create user in Gradual
  const { data: createResponse, status: createStatus } = await createUserInGradual(gradualData)

  if (createStatus !== 200) {
    return new Response(
      JSON.stringify({
        error: 'Failed to create/fetch user in Gradual',
        details: createResponse,
      }),
      {
        status: createStatus,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Step 2: Check if user needs to be updated
  if (needsUpdate(gradualData, createResponse)) {
    // Step 3: Update user if needed
    const { data: updateResponse, status: updateStatus } = await updateUserInGradual(gradualData)

    if (updateStatus !== 200) {
      return new Response(
        JSON.stringify({
          warning: 'User was created/found but update failed',
          create_response: createResponse,
          update_error: updateResponse,
        }),
        {
          status: 207, // Multi-Status
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    return new Response(
      JSON.stringify({
        message: 'User updated successfully',
        original_response: createResponse,
        updated_response: updateResponse,
        action: 'updated',
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // User was created or already exists with correct data
  return new Response(
    JSON.stringify({
      message: 'User processed successfully',
      response: createResponse,
      action: 'created_or_no_update_needed',
    }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  )
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Validate credentials are configured
  if (!GRADUAL_CLIENT_ID || !GRADUAL_BEARER_TOKEN) {
    console.error('Gradual API credentials not configured')
    return new Response(
      JSON.stringify({ error: 'Gradual API credentials not configured' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Only allow POST and PATCH requests
  if (req.method !== 'POST' && req.method !== 'PATCH') {
    return new Response(JSON.stringify({ error: 'Only POST and PATCH methods are allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Parse request data
  let requestData: Record<string, unknown>
  try {
    requestData = await req.json()
    if (!requestData) {
      return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
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

  // Route based on mode (for pg_net trigger calls which can only POST)
  if (requestData.mode === 'register_single') {
    return handleEventRegistration(requestData as unknown as EventRegistrationPayload)
  }

  if (requestData.mode === 'batch_sync') {
    const { jobId } = requestData as unknown as BatchSyncPayload
    if (!jobId) {
      return new Response(JSON.stringify({ error: 'Missing required field: jobId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    return handleBatchSync(jobId)
  }

  // Route based on HTTP method (existing behavior)
  if (req.method === 'PATCH') {
    return handleEventRegistration(requestData as unknown as EventRegistrationPayload)
  }

  return handleUserSync(requestData as unknown as UserPayload)
})
