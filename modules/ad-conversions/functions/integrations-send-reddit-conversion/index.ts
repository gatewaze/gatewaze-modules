import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * Send Reddit Conversion
 *
 * Sends conversion events to Reddit Conversions API (CAPI) for
 * Reddit ad attribution.
 *
 * This function is called by the send-conversion dispatcher or
 * directly when a registration is matched to a tracking session.
 *
 * Reddit CAPI Documentation:
 * https://business.reddithelp.com/s/article/Conversions-API
 * https://ads-api.reddit.com/docs/v2/#tag/Conversions
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

interface RedditConversionRequest {
  registrationId?: string
  competitionEntryId?: string
  discountCodeId?: string
  trackingSessionId?: string
  eventName?: string // Default: 'SignUp'
  config?: RedditConfig // Optional: Pass config directly instead of looking up
}

interface RedditConfig {
  pixel_id: string
  access_token: string
  test_mode?: boolean
}

interface TrackingSession {
  id: string
  click_ids: Record<string, string>
  platform_cookies: Record<string, string>
  ip_address: string | null
  user_agent: string | null
  landing_page: string | null
}

interface RegistrationData {
  id: string
  event_id: string
  amount_paid: number | null
  currency: string | null
  created_at: string
  email: string
}

/**
 * Hash data for Reddit API using SHA256
 * Reddit requires lowercase, trimmed, SHA256 hashed values
 */
async function hashForReddit(value: string): Promise<string> {
  const normalized = value.toLowerCase().trim()
  const encoder = new TextEncoder()
  const data = encoder.encode(normalized)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Generate a stable conversion ID for deduplication
 * Uses the conversion ID so repeated calls produce the same dedup ID (idempotent).
 */
function generateConversionId(conversionType: string, id: string): string {
  const prefix = conversionType === 'competition_entry' ? 'comp' : conversionType === 'discount_code' ? 'disc' : 'reg'
  return `${prefix}_${id}`
}

/**
 * Map our event names to Reddit tracking types
 * Reddit supported types: PageVisit, ViewContent, Search, AddToCart,
 * AddToWishlist, Purchase, Lead, SignUp, Custom
 */
function mapEventName(eventName: string): { tracking_type: string; custom_event_name?: string } {
  const mapping: Record<string, string> = {
    Lead: 'Lead',
    SignUp: 'SignUp',
    Purchase: 'Purchase',
    Registration: 'SignUp',
    CompleteRegistration: 'SignUp',
  }

  const trackingType = mapping[eventName]
  if (trackingType) {
    return { tracking_type: trackingType }
  }

  // Use Custom for unmapped event names
  return { tracking_type: 'Custom', custom_event_name: eventName }
}

/**
 * Send conversion to Reddit Conversions API
 */
async function sendToRedditCAPI(
  config: RedditConfig,
  eventData: {
    eventType: { tracking_type: string; custom_event_name?: string }
    eventAt: string // ISO 8601
    conversionId: string
    clickId?: string
    user: Record<string, unknown>
    eventMetadata: Record<string, unknown>
  },
  testMode: boolean
): Promise<{ success: boolean; response: unknown; status: number }> {
  const event: Record<string, unknown> = {
    event_at: eventData.eventAt,
    event_type: eventData.eventType,
    event_metadata: {
      conversion_id: eventData.conversionId,
      ...eventData.eventMetadata,
    },
    user: eventData.user,
  }

  // click_id goes at the event level, not inside user
  if (eventData.clickId) {
    event.click_id = eventData.clickId
  }

  const payload = {
    test_mode: testMode,
    events: [event],
  }

  const url = `https://ads-api.reddit.com/api/v2.0/conversions/events/${config.pixel_id}`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.access_token}`,
    },
    body: JSON.stringify(payload),
  })

  const responseData = await response.json()

  return {
    success: response.ok,
    response: responseData,
    status: response.status,
  }
}

/**
 * Get registration data with email
 */
async function getRegistrationData(registrationId: string): Promise<RegistrationData | null> {
  const { data: registration, error: regError } = await supabase
    .from('events_registrations')
    .select(
      `
      id,
      event_id,
      amount_paid,
      currency,
      created_at,
      member_profile_id
    `
    )
    .eq('id', registrationId)
    .single()

  if (regError || !registration) {
    console.error('Registration not found:', regError)
    return null
  }

  const { data: memberProfile } = await supabase
    .from('people_profiles')
    .select('person_id')
    .eq('id', registration.member_profile_id)
    .single()

  if (!memberProfile) {
    console.error('Member profile not found')
    return null
  }

  const { data: person } = await supabase
    .from('people')
    .select('email')
    .eq('id', memberProfile.person_id)
    .single()

  if (!person?.email) {
    console.error('Person email not found')
    return null
  }

  return {
    ...registration,
    email: person.email,
  }
}

/**
 * Get competition entry data with email
 */
async function getCompetitionEntryData(competitionEntryId: string): Promise<RegistrationData | null> {
  const { data: entry, error } = await supabase
    .from('events_competition_entries')
    .select('id, competition_id, member_profile_id, created_at')
    .eq('id', competitionEntryId)
    .single()

  if (error || !entry) {
    console.error('Competition entry not found:', error)
    return null
  }

  const { data: competition } = await supabase
    .from('events_competitions')
    .select('event_id')
    .eq('id', entry.competition_id)
    .single()

  if (!competition) return null

  const { data: memberProfile } = await supabase
    .from('people_profiles')
    .select('person_id')
    .eq('id', entry.member_profile_id)
    .single()

  if (!memberProfile) return null

  const { data: person } = await supabase
    .from('people')
    .select('email')
    .eq('id', memberProfile.person_id)
    .single()

  if (!person?.email) return null

  return {
    id: entry.id,
    event_id: competition.event_id,
    amount_paid: null,
    currency: null,
    created_at: entry.created_at,
    email: person.email,
  }
}

/**
 * Get discount code data with email
 */
async function getDiscountCodeData(discountCodeId: string): Promise<RegistrationData | null> {
  const { data: code, error } = await supabase
    .from('events_discount_codes')
    .select('id, event_id, issued_to, created_at')
    .eq('id', discountCodeId)
    .single()

  if (error || !code || !code.issued_to) {
    console.error('Discount code not found:', error)
    return null
  }

  return {
    id: code.id,
    event_id: code.event_id,
    amount_paid: null,
    currency: null,
    created_at: code.created_at,
    email: code.issued_to,
  }
}

/**
 * Find a matching tracking session using 3-tier matching
 */
async function findTrackingSession(
  email: string,
  eventId: string,
  trackingSessionId?: string
): Promise<TrackingSession | null> {
  const selectFields = 'id, click_ids, platform_cookies, ip_address, user_agent, landing_page'

  // Tier 1: Direct session ID lookup
  if (trackingSessionId) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (uuidRegex.test(trackingSessionId)) {
      const { data: byId } = await supabase
        .from('integrations_ad_tracking_sessions')
        .select(selectFields)
        .eq('id', trackingSessionId)
        .maybeSingle()
      if (byId) return byId
    }

    const { data: bySessionId } = await supabase
      .from('integrations_ad_tracking_sessions')
      .select(selectFields)
      .eq('session_id', trackingSessionId)
      .maybeSingle()
    if (bySessionId) return bySessionId
  }

  // Tier 2: Email hash match
  const emailHash = await hashForReddit(email)

  const { data: emailMatch } = await supabase
    .from('integrations_ad_tracking_sessions')
    .select(selectFields)
    .eq('email_hash', emailHash)
    .eq('event_id', eventId)
    .eq('status', 'pending')
    .gte('expires_at', new Date().toISOString())
    .order('clicked_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (emailMatch) return emailMatch

  // Tier 3: Timing-based fallback
  // Exclude sessions that were redirected — if session ID was in the URL and
  // registration didn't carry it back, it's a different person.
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const { data: timingMatch } = await supabase
    .from('integrations_ad_tracking_sessions')
    .select(selectFields)
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
    await supabase
      .from('integrations_ad_tracking_sessions')
      .update({ email_hash: emailHash, matched_via: 'timing_heuristic' })
      .eq('id', timingMatch.id)
    console.log('Matched tracking session via timing heuristic:', timingMatch.id)
  }

  return timingMatch
}

/**
 * Get Reddit config for an event (event-level -> account-level -> brand default -> env vars)
 */
async function getRedditConfig(eventId: string): Promise<RedditConfig | null> {
  const { data } = await supabase.rpc('get_ad_platform_config', {
    p_event_id: eventId,
    p_platform: 'reddit',
  })

  if (data?.credentials) {
    const credentials = data.credentials as Record<string, string>
    if (credentials.pixel_id && credentials.access_token) {
      return {
        pixel_id: credentials.pixel_id,
        access_token: credentials.access_token,
        test_mode: credentials.test_mode === 'true',
      }
    }
  }

  // Fall back to env vars (skip if set to '0' placeholder)
  const pixelId = Deno.env.get('REDDIT_PIXEL_ID')
  const accessToken = Deno.env.get('REDDIT_ACCESS_TOKEN')
  if (pixelId && accessToken && pixelId !== '0' && accessToken !== '0') {
    console.log('Using Reddit env var fallback config for event:', eventId)
    return {
      pixel_id: pixelId,
      access_token: accessToken,
      test_mode: Deno.env.get('REDDIT_TEST_MODE') === 'true',
    }
  }

  return null
}

/**
 * Update tracking session status after conversion
 */
async function updateTrackingSessionConverted(
  sessionId: string,
  registrationId: string,
  eventId: string,
  platform: string
): Promise<void> {
  const now = new Date().toISOString()

  const { data: session } = await supabase
    .from('integrations_ad_tracking_sessions')
    .select('conversions_sent')
    .eq('id', sessionId)
    .single()

  const currentConversions = (session?.conversions_sent as Record<string, unknown>) || {}
  const updatedConversions = {
    ...currentConversions,
    [platform]: {
      sent_at: now,
      event_id: eventId,
    },
  }

  await supabase
    .from('integrations_ad_tracking_sessions')
    .update({
      status: 'converted',
      matched_registration_id: registrationId,
      matched_at: now,
      conversions_sent: updatedConversions,
    })
    .eq('id', sessionId)
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
    const body: RedditConversionRequest = await req.json()
    const { registrationId, competitionEntryId, discountCodeId, trackingSessionId, eventName = 'SignUp', config: providedConfig } = body

    if (!registrationId && !competitionEntryId && !discountCodeId) {
      return new Response(JSON.stringify({ error: 'registrationId, competitionEntryId, or discountCodeId is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const conversionId = registrationId || competitionEntryId || discountCodeId!
    const conversionType = competitionEntryId ? 'competition_entry' : discountCodeId ? 'discount_code' : 'registration'
    console.log('Processing Reddit conversion:', { conversionType, conversionId })

    // 1. Get conversion data
    let registration: RegistrationData | null = null
    if (competitionEntryId) {
      registration = await getCompetitionEntryData(competitionEntryId)
    } else if (discountCodeId) {
      registration = await getDiscountCodeData(discountCodeId)
    } else {
      registration = await getRegistrationData(registrationId!)
    }
    if (!registration) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `${conversionType} not found`,
        }),
        {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    // 2. Get Reddit config
    const config = providedConfig || (await getRedditConfig(registration.event_id))
    if (!config) {
      console.log('No Reddit config found for event:', registration.event_id)
      return new Response(
        JSON.stringify({
          success: false,
          reason: 'no_config',
          message: 'No Reddit pixel configuration found for this event',
        }),
        {
          status: 200, // Not an error, just no config
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    // 3. Find tracking session
    const trackingSession = await findTrackingSession(registration.email, registration.event_id, trackingSessionId)

    // 4. Build user object for Reddit
    const hashedEmail = await hashForReddit(registration.email)
    const user: Record<string, unknown> = {
      email: hashedEmail,
    }

    // Add tracking data if we have a session
    let clickId: string | undefined
    if (trackingSession) {
      const cookies = trackingSession.platform_cookies as Record<string, string>
      const clickIds = trackingSession.click_ids as Record<string, string>

      // Reddit click ID (rdt_cid) — goes at event level, not in user object
      if (clickIds.rdt_cid) {
        clickId = clickIds.rdt_cid
      }

      // Reddit UUID cookie (_rdt_uuid)
      if (cookies._rdt_uuid) {
        user.uuid = cookies._rdt_uuid
      }

      // Add client info
      if (trackingSession.ip_address) {
        user.ip_address = trackingSession.ip_address
      }
      if (trackingSession.user_agent) {
        user.user_agent = trackingSession.user_agent
      }
    }

    // 5. Build event metadata
    const eventMetadata: Record<string, unknown> = {}

    // Determine event type: Use Purchase if there's a payment, otherwise use provided eventName
    const hasPaidAmount = registration.amount_paid && registration.amount_paid > 0
    const resolvedEventName = hasPaidAmount ? 'Purchase' : eventName
    const eventType = mapEventName(resolvedEventName)

    if (hasPaidAmount) {
      eventMetadata.value_decimal = registration.amount_paid
      eventMetadata.currency = registration.currency || 'USD'
      // item_count is only supported for Purchase events, not SignUp
      if (eventType.tracking_type === 'Purchase') {
        eventMetadata.item_count = 1
      }
    }

    // 6. Generate conversion ID for deduplication
    const dedupId = generateConversionId(conversionType, conversionId)
    const eventAt = new Date(registration.created_at).toISOString()

    // Determine test mode
    const testMode = config.test_mode || false

    // 7. Log the conversion attempt
    const { data: logEntry } = await supabase.rpc('integrations_log_conversion_event', {
      p_tracking_session_id: trackingSession?.id || null,
      p_registration_id: conversionId,
      p_event_id: registration.event_id,
      p_platform: 'reddit',
      p_event_name: eventType.tracking_type,
      p_dedup_event_id: dedupId,
      p_request_payload: {
        event_type: eventType,
        event_at: eventAt,
        user: { ...user, email: '[HASHED]' }, // Don't log actual hash
        event_metadata: eventMetadata,
        click_id: clickId ? '[PRESENT]' : undefined,
        test_mode: testMode,
      },
      p_request_url: `https://ads-api.reddit.com/api/v2.0/conversions/events/${config.pixel_id}`,
    })

    // 8. Send to Reddit CAPI
    const result = await sendToRedditCAPI(
      config,
      {
        eventType,
        eventAt,
        conversionId: dedupId,
        clickId,
        user,
        eventMetadata,
      },
      testMode
    )

    // 9. Update log with response
    if (logEntry) {
      await supabase.rpc('integrations_update_conversion_log_response', {
        p_log_id: logEntry,
        p_http_status: result.status,
        p_response_payload: result.response,
        p_success: result.success,
        p_error_message: result.success ? null : JSON.stringify(result.response),
        p_error_code: null,
      })
    }

    // 10. Update tracking session if matched
    if (trackingSession && result.success) {
      await updateTrackingSessionConverted(trackingSession.id, conversionId, dedupId, 'reddit')
    }

    console.log('Reddit conversion result:', {
      success: result.success,
      conversionType,
      conversionId,
      dedupId,
      hasTrackingSession: !!trackingSession,
      hasClickId: !!clickId,
      status: result.status,
      testMode,
    })

    return new Response(
      JSON.stringify({
        success: result.success,
        conversionId: dedupId,
        hasTrackingSession: !!trackingSession,
        hasClickId: !!clickId,
        ...(testMode && { testMode: true }),
        response: result.response,
      }),
      {
        status: result.success ? 200 : 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error('Error sending Reddit conversion:', error)
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
