import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * Send Conversion - Dispatcher
 *
 * This Edge Function acts as the main entry point for sending conversions
 * to ad platforms. It:
 *
 * 1. Takes a registration ID (and optionally a tracking session ID)
 * 2. Finds the relevant tracking session
 * 3. Determines which ad platforms have active configurations
 * 4. Dispatches to platform-specific conversion functions
 *
 * This design allows easy addition of new platforms (Google, Reddit, etc.)
 * without modifying the webhook that triggers conversions.
 */

const supabaseUrl = Deno.env.get('SUPABASE_URL')!

// SUPABASE_SERVICE_ROLE_KEY is auto-populated but may use the new sb_secret_ format
// which isn't a valid JWT for Bearer auth. Fall back to brand-specific JWT keys.
const autoKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const supabaseServiceKey = autoKey.startsWith('eyJ')
  ? autoKey
  : (Deno.env.get('TECHTICKETS_SERVICE_ROLE_KEY') || Deno.env.get('MLOPS_SERVICE_ROLE_KEY') || autoKey)

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

// Supported platforms and their Edge Function names
const PLATFORM_FUNCTIONS: Record<string, string> = {
  meta: 'send-meta-conversion',
  reddit: 'send-reddit-conversion',
  // Future platforms:
  // google: 'send-google-conversion',
  // bing: 'send-bing-conversion',
  // linkedin: 'send-linkedin-conversion',
  // tiktok: 'send-tiktok-conversion',
}

interface ConversionRequest {
  registrationId?: string
  competitionEntryId?: string
  discountCodeId?: string
  trackingSessionId?: string
  platforms?: string[] // Optional: Only send to specific platforms
  eventName?: string // Optional: Override default event name
}

interface PlatformResult {
  platform: string
  success: boolean
  error?: string
  details?: unknown
}

/**
 * Hash email for matching tracking sessions
 */
async function hashEmail(email: string): Promise<string> {
  const normalized = email.toLowerCase().trim()
  const encoder = new TextEncoder()
  const data = encoder.encode(normalized)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Get registration details including email and metadata
 */
async function getRegistrationDetails(registrationId: string) {
  const { data: registration, error } = await supabase
    .from('events_registrations')
    .select(
      `
      id,
      event_id,
      member_profile_id,
      registration_metadata
    `
    )
    .eq('id', registrationId)
    .single()

  if (error || !registration) {
    return null
  }

  // Get email from people_profiles -> people
  const { data: memberProfile } = await supabase
    .from('people_profiles')
    .select('person_id')
    .eq('id', registration.member_profile_id)
    .single()

  if (!memberProfile) return null

  const { data: person } = await supabase.from('people').select('email').eq('id', memberProfile.person_id).single()

  if (!person?.email) return null

  return {
    ...registration,
    email: person.email,
    registration_metadata: registration.registration_metadata as Record<string, unknown> | null,
  }
}

/**
 * Get competition entry details including email and metadata
 */
async function getCompetitionEntryDetails(competitionEntryId: string) {
  const { data: entry, error } = await supabase
    .from('events_competition_entries')
    .select(
      `
      id,
      competition_id,
      member_profile_id,
      entry_metadata
    `
    )
    .eq('id', competitionEntryId)
    .single()

  if (error || !entry) {
    return null
  }

  // Get event_id from competition
  const { data: competition } = await supabase
    .from('events_competitions')
    .select('event_id')
    .eq('id', entry.competition_id)
    .single()

  if (!competition) return null

  // Get email from people_profiles -> people
  const { data: memberProfile } = await supabase
    .from('people_profiles')
    .select('person_id')
    .eq('id', entry.member_profile_id)
    .single()

  if (!memberProfile) return null

  const { data: person } = await supabase.from('people').select('email').eq('id', memberProfile.person_id).single()

  if (!person?.email) return null

  return {
    id: entry.id,
    event_id: competition.event_id,
    email: person.email,
    entry_metadata: entry.entry_metadata as Record<string, unknown> | null,
  }
}

/**
 * Get discount code details including email and event_id
 */
async function getDiscountCodeDetails(discountCodeId: string) {
  const { data: code, error } = await supabase
    .from('events_discount_codes')
    .select(
      `
      id,
      code,
      event_id,
      issued_to,
      member_profile_id
    `
    )
    .eq('id', discountCodeId)
    .single()

  if (error || !code || !code.issued_to) {
    return null
  }

  // For discount codes, email is directly in issued_to field
  // and event_id is already in the table (it's a text field, not a UUID)
  return {
    id: code.id,
    event_id: code.event_id,
    email: code.issued_to,
    code_metadata: null, // discount_codes doesn't have metadata field
  }
}

/**
 * Find tracking session for a registration using 3-tier matching:
 * 1. Direct session ID lookup (highest priority — from form metadata or CSV custom_source)
 * 2. Email hash + event_id match (existing sessions with email)
 * 3. Timing-based fallback (recent session for same event without email hash)
 */
async function findTrackingSession(
  email: string,
  eventId: string,
  trackingSessionId?: string
): Promise<{
  id: string
  click_ids: Record<string, string>
  consented_platforms: string[]
} | null> {
  // Tier 1: Direct session ID lookup
  if (trackingSessionId) {
    // Try as UUID first (database id) — only if it looks like a UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (uuidRegex.test(trackingSessionId)) {
      const { data: byId } = await supabase
        .from('integrations_ad_tracking_sessions')
        .select('id, click_ids, consented_platforms')
        .eq('id', trackingSessionId)
        .maybeSingle()
      if (byId) return byId
    }

    // Also try as session_id string (from cookie/UTM)
    const { data: bySessionId } = await supabase
      .from('integrations_ad_tracking_sessions')
      .select('id, click_ids, consented_platforms')
      .eq('session_id', trackingSessionId)
      .maybeSingle()
    if (bySessionId) return bySessionId
  }

  // Tier 2: Email hash + event_id match
  const emailHash = await hashEmail(email)

  const { data: emailMatch } = await supabase
    .from('integrations_ad_tracking_sessions')
    .select('id, click_ids, consented_platforms')
    .eq('email_hash', emailHash)
    .eq('event_id', eventId)
    .eq('status', 'pending')
    .gte('expires_at', new Date().toISOString())
    .order('clicked_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (emailMatch) return emailMatch

  // Tier 3: Timing-based fallback — find recent session for same event without email
  // Only match sessions that were NOT redirected to an external registration page.
  // If a session was redirected, the session ID was encoded in the URL (utm_source),
  // so Tier 1 should have matched. If it didn't, the registration is from a different
  // person and matching by timing would be a false attribution.
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const { data: timingMatch } = await supabase
    .from('integrations_ad_tracking_sessions')
    .select('id, click_ids, consented_platforms')
    .eq('event_id', eventId)
    .eq('status', 'pending')
    .is('email_hash', null)
    .is('external_redirect_at', null)
    .gte('created_at', thirtyMinutesAgo)
    .gte('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (timingMatch) {
    // Backfill email hash for future lookups and audit
    await supabase
      .from('integrations_ad_tracking_sessions')
      .update({ email_hash: emailHash, matched_via: 'timing_heuristic' })
      .eq('id', timingMatch.id)
    console.log('Matched tracking session via timing heuristic:', timingMatch.id)
  }

  return timingMatch
}

/**
 * Get active platform configurations for an event
 * Falls back to: event → account → brand default → env vars
 */
async function getActivePlatformConfigs(eventId: string): Promise<string[]> {
  // Get account_id for this event
  const { data: event } = await supabase.from('events').select('account_id').eq('event_id', eventId).single()

  // Find all active configs for this event or its account
  const orClauses = [`event_id.eq.${eventId}`]
  if (event?.account_id) {
    orClauses.push(`account_id.eq.${event.account_id}`)
  }

  const { data: configs } = await supabase
    .from('ad_platform_configs')
    .select('platform')
    .eq('is_active', true)
    .or(orClauses.join(','))

  const platforms = configs?.map((c) => c.platform) || []

  // If no DB configs found, check env vars as final fallback
  if (platforms.length === 0) {
    const metaPixelId = Deno.env.get('META_PIXEL_ID')
    const metaAccessToken = Deno.env.get('META_ACCESS_TOKEN')
    if (metaPixelId && metaAccessToken) {
      console.log('Using Meta env var fallback config')
      platforms.push('meta')
    }

    const redditPixelId = Deno.env.get('REDDIT_PIXEL_ID')
    const redditAccessToken = Deno.env.get('REDDIT_ACCESS_TOKEN')
    if (redditPixelId && redditAccessToken) {
      console.log('Using Reddit env var fallback config')
      platforms.push('reddit')
    }
  }

  return [...new Set(platforms)] // deduplicate
}

/**
 * Call a platform-specific conversion function
 */
async function callPlatformFunction(
  functionName: string,
  registrationId: string | undefined,
  competitionEntryId: string | undefined,
  discountCodeId: string | undefined,
  trackingSessionId: string | undefined,
  eventName: string | undefined
): Promise<PlatformResult> {
  const platform = Object.entries(PLATFORM_FUNCTIONS).find(([_, fn]) => fn === functionName)?.[0] || 'unknown'

  try {
    const payload: Record<string, unknown> = {
      trackingSessionId,
      eventName,
    }
    if (registrationId) payload.registrationId = registrationId
    if (competitionEntryId) payload.competitionEntryId = competitionEntryId
    if (discountCodeId) payload.discountCodeId = discountCodeId

    const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${supabaseServiceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    const result = await response.json()

    return {
      platform,
      success: response.ok && result.success !== false,
      details: result,
      error: result.error || (response.ok ? undefined : `HTTP ${response.status}`),
    }
  } catch (error) {
    return {
      platform,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Determine which platforms to send conversions to
 */
function determinePlatformsToSend(
  requestedPlatforms: string[] | undefined,
  activePlatforms: string[],
  trackingSession: { click_ids: Record<string, string>; consented_platforms: string[] } | null
): string[] {
  // Start with active platforms
  let platforms = activePlatforms.filter((p) => PLATFORM_FUNCTIONS[p])

  // Filter to requested platforms if specified
  if (requestedPlatforms?.length) {
    platforms = platforms.filter((p) => requestedPlatforms.includes(p))
  }

  // Filter to consented platforms if tracking session exists
  if (trackingSession?.consented_platforms?.length) {
    platforms = platforms.filter((p) => trackingSession.consented_platforms.includes(p))
  }

  // Only send to platforms that have their specific click ID
  // This prevents false attributions from timing heuristic matches
  // where the session doesn't actually have the platform's click ID
  const clickIdParams: Record<string, string> = {
    meta: 'fbclid',
    google: 'gclid',
    reddit: 'rdt_cid',
    bing: 'msclkid',
    linkedin: 'li_fat_id',
    tiktok: 'ttclid',
  }
  if (trackingSession) {
    platforms = platforms.filter(p => {
      const clickIdParam = clickIdParams[p]
      if (!clickIdParam) return true // Unknown platform, don't filter
      return trackingSession.click_ids[clickIdParam]
    })
  }

  return platforms
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    const body: ConversionRequest = await req.json()
    const { registrationId, competitionEntryId, discountCodeId, trackingSessionId, platforms: requestedPlatforms, eventName } = body

    if (!registrationId && !competitionEntryId && !discountCodeId) {
      return new Response(JSON.stringify({ error: 'registrationId, competitionEntryId, or discountCodeId is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    console.log('Processing conversion:', { registrationId, competitionEntryId, discountCodeId })

    // 1. Get conversion details (registration, competition entry, or discount code)
    let conversionDetails: { id: string; event_id: string; email: string; metadata?: Record<string, unknown> | null } | null = null
    let conversionType = 'registration'

    if (discountCodeId) {
      conversionDetails = await getDiscountCodeDetails(discountCodeId)
      conversionType = 'discount_code'
      if (!conversionDetails) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Discount code not found',
          }),
          {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        )
      }
    } else if (competitionEntryId) {
      conversionDetails = await getCompetitionEntryDetails(competitionEntryId)
      conversionType = 'competition_entry'
      if (!conversionDetails) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Competition entry not found',
          }),
          {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        )
      }
    } else {
      const registration = await getRegistrationDetails(registrationId!)
      if (!registration) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Registration not found',
          }),
          {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        )
      }
      conversionDetails = {
        id: registration.id,
        event_id: registration.event_id,
        email: registration.email,
        metadata: registration.registration_metadata,
      }
    }

    // 2. Find tracking session
    // If no explicit trackingSessionId was passed, check metadata
    const resolvedTrackingSessionId =
      trackingSessionId ||
      (conversionDetails.metadata?.tracking_session_id as string | undefined)

    const trackingSession = await findTrackingSession(conversionDetails.email, conversionDetails.event_id, resolvedTrackingSessionId)

    console.log('Tracking session found:', !!trackingSession)

    // 3. Get active platform configs
    const activePlatforms = await getActivePlatformConfigs(conversionDetails.event_id)

    console.log('Active platforms:', activePlatforms)

    if (activePlatforms.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'No active ad platform configurations for this event',
          platformsProcessed: 0,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    // 4. Determine which platforms to send to
    const platformsToSend = determinePlatformsToSend(requestedPlatforms, activePlatforms, trackingSession)

    console.log('Platforms to send:', platformsToSend)

    if (platformsToSend.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'No platforms to send conversions to (filtered by consent or request)',
          activePlatforms,
          platformsProcessed: 0,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    // 5. Resolve event name: default to 'SubmitApplication' for competition entries, 'Lead' for others
    const resolvedEventName = eventName || (competitionEntryId ? 'SubmitApplication' : undefined)

    // 6. Send to each platform (in parallel)
    const results = await Promise.all(
      platformsToSend.map((platform) =>
        callPlatformFunction(PLATFORM_FUNCTIONS[platform], registrationId, competitionEntryId, discountCodeId, trackingSession?.id, resolvedEventName)
      )
    )

    // 7. Summarize results
    const successful = results.filter((r) => r.success)
    const failed = results.filter((r) => !r.success)

    console.log('Conversion results:', {
      conversionType,
      registrationId,
      competitionEntryId,
      discountCodeId,
      successful: successful.map((r) => r.platform),
      failed: failed.map((r) => ({ platform: r.platform, error: r.error })),
    })

    return new Response(
      JSON.stringify({
        success: failed.length === 0,
        conversionType,
        ...(registrationId && { registrationId }),
        ...(competitionEntryId && { competitionEntryId }),
        ...(discountCodeId && { discountCodeId }),
        eventId: conversionDetails.event_id,
        hasTrackingSession: !!trackingSession,
        platformsProcessed: platformsToSend.length,
        results: {
          successful: successful.map((r) => r.platform),
          failed: failed.map((r) => ({
            platform: r.platform,
            error: r.error,
          })),
        },
        details: results,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error('Error processing conversion:', error)
    return new Response(
      JSON.stringify({
        success: false,
        error: errorMessage,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }
})
