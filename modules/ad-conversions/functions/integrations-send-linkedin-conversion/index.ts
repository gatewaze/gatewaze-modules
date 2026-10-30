import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { isTrustedCaller, unauthorizedResponse } from '../_shared/auth.ts'
import { sessionConsentsTo } from '../_shared/consent.ts'
import {
  LINKEDIN_API_BASE,
  buildConversionEvent,
  buildUserIds,
  linkedInHeaders,
  type LinkedInConfig,
} from '../_shared/linkedin.ts'

/**
 * Send LinkedIn Conversion
 *
 * Streams one conversion event to the LinkedIn Conversions API for a
 * registration. Called by the integrations-send-conversion dispatcher with the
 * service-role key; not reachable without it.
 *
 * Match keys sent: SHA-256 email always; the li_fat_id click id and the click
 * IP when the registration matched a tracking session. Conversion value is
 * sent for paid registrations.
 *
 * Config resolution: ad_platform_configs via get_ad_platform_config
 * (event → account → brand-wide), then LINKEDIN_CONVERSION_ID /
 * LINKEDIN_ACCESS_TOKEN env vars. LinkedIn access tokens expire (60 days) and
 * need rotating; a 401 from LinkedIn lands in integrations_conversion_log.
 */

const supabaseUrl = Deno.env.get('SUPABASE_URL')!

// SUPABASE_SERVICE_ROLE_KEY is auto-populated but may use the new sb_secret_ format
// which isn't a valid JWT for Bearer auth. Fall back to an explicitly-provided JWT key.
const autoKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const supabaseServiceKey = autoKey.startsWith('eyJ')
  ? autoKey
  : (Deno.env.get('SERVICE_ROLE_JWT_KEY') || autoKey)

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

interface LinkedInConversionRequest {
  registrationId?: string
  trackingSessionId?: string
  eventName?: string // informational only; LinkedIn's event type lives on the conversion rule
  config?: LinkedInConfig // Optional: pass config directly instead of looking it up
}

interface TrackingSession {
  id: string
  click_ids: Record<string, string> | null
  ip_address: string | null
  user_agent: string | null
  landing_page: string | null
  tracking_consent: boolean | null
  consented_platforms: string[] | null
}

interface RegistrationData {
  id: string
  event_id: string
  amount_paid: number | null
  currency: string | null
  created_at: string
  registered_at: string | null
  email: string
}

async function sha256Lower(value: string): Promise<string> {
  const normalized = value.toLowerCase().trim()
  const data = new TextEncoder().encode(normalized)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function getRegistrationData(registrationId: string): Promise<RegistrationData | null> {
  const { data: registration, error } = await supabase
    .from('events_registrations')
    .select('id, event_id, amount_paid, currency, created_at, registered_at, person_id')
    .eq('id', registrationId)
    .single()

  if (error || !registration) {
    console.error('Registration not found:', error)
    return null
  }

  const { data: person } = await supabase.from('people').select('email').eq('id', registration.person_id).single()
  if (!person?.email) {
    console.error('Person email not found')
    return null
  }

  return { ...registration, email: person.email }
}

/**
 * Same three-tier match as the other senders: direct session id, then email
 * hash + event, then a recent un-redirected session for the event.
 */
async function findTrackingSession(
  email: string,
  eventId: string,
  trackingSessionId?: string
): Promise<TrackingSession | null> {
  const selectFields = 'id, click_ids, ip_address, user_agent, landing_page, tracking_consent, consented_platforms'

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

  const emailHash = await sha256Lower(email)
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

  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const { data: timingMatch } = await supabase
    .from('integrations_ad_tracking_sessions')
    .select(selectFields)
    .eq('event_id', eventId)
    .eq('status', 'pending')
    .is('email_hash', null)
    .is('external_redirect_at', null)
    .eq('tracking_consent', true)
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

async function getLinkedInConfig(eventId: string): Promise<LinkedInConfig | null> {
  const { data } = await supabase.rpc('get_ad_platform_config', {
    p_event_id: eventId,
    p_platform: 'linkedin',
  })

  if (data?.credentials) {
    const c = data.credentials as Record<string, string>
    if (c.conversion_id && c.access_token) {
      return {
        conversion_id: c.conversion_id,
        access_token: c.access_token,
        purchase_conversion_id: c.purchase_conversion_id || undefined,
        api_version: c.api_version || undefined,
      }
    }
  }

  const conversionId = Deno.env.get('LINKEDIN_CONVERSION_ID')
  const accessToken = Deno.env.get('LINKEDIN_ACCESS_TOKEN')
  if (conversionId && accessToken && conversionId !== '0' && accessToken !== '0') {
    console.log('Using LinkedIn env var fallback config for event:', eventId)
    return {
      conversion_id: conversionId,
      access_token: accessToken,
      purchase_conversion_id: Deno.env.get('LINKEDIN_PURCHASE_CONVERSION_ID') || undefined,
      api_version: Deno.env.get('LINKEDIN_API_VERSION') || undefined,
    }
  }

  return null
}

async function updateTrackingSessionConverted(sessionId: string, registrationId: string, dedupId: string): Promise<void> {
  const now = new Date().toISOString()
  const { data: session } = await supabase
    .from('integrations_ad_tracking_sessions')
    .select('conversions_sent')
    .eq('id', sessionId)
    .single()

  const current = (session?.conversions_sent as Record<string, unknown>) || {}
  await supabase
    .from('integrations_ad_tracking_sessions')
    .update({
      status: 'converted',
      matched_registration_id: registrationId,
      matched_at: now,
      conversions_sent: { ...current, linkedin: { sent_at: now, event_id: dedupId } },
    })
    .eq('id', sessionId)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (!isTrustedCaller(req)) {
    return unauthorizedResponse(corsHeaders)
  }

  try {
    const body: LinkedInConversionRequest = await req.json()
    const { registrationId, trackingSessionId, config: providedConfig } = body

    if (!registrationId) {
      return new Response(JSON.stringify({ error: 'registrationId is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 1. Registration + email
    const registration = await getRegistrationData(registrationId)
    if (!registration) {
      return new Response(JSON.stringify({ success: false, error: 'registration not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 2. Config
    const config = providedConfig || (await getLinkedInConfig(registration.event_id))
    if (!config) {
      console.log('No LinkedIn config found for event:', registration.event_id)
      return new Response(
        JSON.stringify({
          success: false,
          reason: 'no_config',
          message: 'No LinkedIn conversion configuration found for this event',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 3. Tracking session (click id + ip), used only with consent for LinkedIn
    const matchedSession = await findTrackingSession(registration.email, registration.event_id, trackingSessionId)
    const trackingSession = matchedSession && sessionConsentsTo(matchedSession, 'linkedin') ? matchedSession : null
    const liFatId = trackingSession?.click_ids?.li_fat_id || null

    // 4. Payload
    const hashedEmail = await sha256Lower(registration.email)
    const userIds = buildUserIds({ hashedEmail, liFatId, ipAddress: trackingSession?.ip_address })
    const dedupId = `reg_${registration.id}`
    const event = buildConversionEvent({
      config,
      happenedAt: new Date(registration.registered_at || registration.created_at),
      eventId: dedupId,
      userIds,
      amountPaid: registration.amount_paid,
      currency: registration.currency,
    })

    const requestUrl = `${LINKEDIN_API_BASE}/conversionEvents`

    // 5. Log the attempt (hashes and click ids redacted)
    const { data: logEntry } = await supabase.rpc('integrations_log_conversion_event', {
      p_tracking_session_id: trackingSession?.id || null,
      p_registration_id: registration.id,
      p_event_id: registration.event_id,
      p_platform: 'linkedin',
      p_event_name: event.conversionValue ? 'Purchase' : 'Lead',
      p_dedup_event_id: dedupId,
      p_request_payload: {
        conversion: event.conversion,
        conversionHappenedAt: event.conversionHappenedAt,
        conversionValue: event.conversionValue,
        userIdTypes: userIds.map((u) => u.idType),
        eventId: event.eventId,
      },
      p_request_url: requestUrl,
    })

    // 6. Send
    let status = 0
    let responsePayload: unknown = null
    let success = false
    try {
      const res = await fetch(requestUrl, {
        method: 'POST',
        headers: linkedInHeaders(config),
        body: JSON.stringify(event),
      })
      status = res.status
      const text = await res.text()
      try {
        responsePayload = text ? JSON.parse(text) : null
      } catch {
        responsePayload = { raw: text.slice(0, 2000) }
      }
      success = res.ok
    } catch (err) {
      responsePayload = { error: err instanceof Error ? err.message : String(err) }
    }

    // 7. Record the outcome
    if (logEntry) {
      await supabase.rpc('integrations_update_conversion_log_response', {
        p_log_id: logEntry,
        p_http_status: status,
        p_response_payload: responsePayload,
        p_success: success,
        p_error_message: success ? null : JSON.stringify(responsePayload),
        p_error_code: success ? null : status ? `HTTP_${status}` : 'NETWORK',
      })
    }

    if (trackingSession && success) {
      await updateTrackingSessionConverted(trackingSession.id, registration.id, dedupId)
    }

    console.log('LinkedIn conversion result:', {
      success,
      status,
      registrationId: registration.id,
      hasTrackingSession: !!trackingSession,
      hasClickId: !!liFatId,
    })

    return new Response(
      JSON.stringify({
        success,
        eventId: dedupId,
        hasTrackingSession: !!trackingSession,
        hasClickId: !!liFatId,
        status,
        response: responsePayload,
      }),
      { status: success ? 200 : 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error('Error sending LinkedIn conversion:', error)
    return new Response(JSON.stringify({ success: false, error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
