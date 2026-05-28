import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  createFullRegistration,
  cancelRegistration,
  updateRegistrationStatus,
  mapApprovalStatus,
  type RegistrationData,
  type EventData,
} from '../_shared/lumaRegistration.ts'

/**
 * Process Luma Webhook
 *
 * This edge function receives webhook events from Luma (premium calendars)
 * for real-time registration syncing.
 *
 * Supported webhook events:
 * - guest.registered: New guest registration
 * - guest.updated: Registration status change (approval, cancellation, waitlist)
 * - ticket.registered: Paid ticket purchase
 *
 * Setup:
 * 1. Deploy this function to Supabase
 * 2. Register webhook in Luma via API:
 *    POST https://api.lu.ma/public/v1/webhooks/create
 *    {
 *      "url": "https://YOUR_PROJECT.supabase.co/functions/v1/process-luma-webhook",
 *      "event_types": ["guest.registered", "guest.updated", "ticket.registered"]
 *    }
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
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-luma-signature',
}

// Luma webhook payload types
interface LumaWebhookPayload {
  type: 'guest.registered' | 'guest.updated' | 'ticket.registered'
  data: LumaGuestData
}

interface LumaGuestData {
  id: string // Guest ID (api_id)
  user_id: string // User ID (usr-XXX)
  user_email: string
  user_name?: string
  user_first_name?: string
  user_last_name?: string
  approval_status: 'approved' | 'session' | 'pending_approval' | 'invited' | 'declined' | 'waitlist'
  registered_at?: string
  phone_number?: string
  custom_source?: string
  eth_address?: string
  solana_address?: string
  registration_answers?: LumaRegistrationAnswer[]
  check_in_qr_code?: string
  invited_at?: string
  joined_at?: string
  event_tickets?: LumaTicket[]
  event_ticket_orders?: LumaTicketOrder[]
  event_ticket?: LumaTicket // Single ticket for ticket.registered event
  event: LumaEvent
}

interface LumaRegistrationAnswer {
  question_id: string
  question_label?: string
  question_type?: string
  answer?: string
  answers?: string[]
}

interface LumaTicket {
  api_id: string
  amount?: number
  currency?: string
  checked_in?: boolean
  event_ticket_type_api_id?: string
  ticket_type_name?: string
}

interface LumaTicketOrder {
  api_id: string
  amount?: number
  currency?: string
  coupon_info?: {
    code?: string
    discount_amount?: number
  }
  is_captured?: boolean
}

interface LumaEvent {
  api_id: string // This is the luma_event_id (evt-XXX)
  name?: string
  start_at?: string
  end_at?: string
  timezone?: string
  geo_address_json?: {
    city?: string
    country?: string
    full_address?: string
  }
}

/**
 * Verify webhook signature using HMAC-SHA256.
 * Looks up the webhook secret from the calendar associated with the event.
 *
 * Lookup path:
 *   1. Parse payload → extract luma_event_id
 *   2. events (by luma_event_id) → calendars_events → calendars.luma_webhook_secret
 *   3. If event not found, try all calendar secrets as fallback
 *   4. If no secrets configured anywhere, allow the request (graceful degradation)
 */
async function verifyWebhookSignature(
  payload: string,
  signature: string | null,
  lumaEventId: string | undefined,
): Promise<boolean> {
  // If no signature header provided, we can't verify — allow if no secrets are configured
  if (!signature) {
    console.log('No x-luma-signature header — skipping verification')
    return true
  }

  let secretToTry: string | null = null

  // Path 1: Look up secret via the event's calendar
  if (lumaEventId) {
    const { data: calendarRow } = await supabase
      .from('events')
      .select('calendars_events!inner(calendars!inner(luma_webhook_secret))')
      .eq('luma_event_id', lumaEventId)
      .limit(1)
      .maybeSingle()

    if (calendarRow) {
      // Navigate the nested join — may be array or object depending on cardinality
      const ce = (calendarRow as any).calendars_events
      const entries = Array.isArray(ce) ? ce : [ce]
      for (const entry of entries) {
        const cal = entry?.calendars
        const secret = Array.isArray(cal) ? cal[0]?.luma_webhook_secret : cal?.luma_webhook_secret
        if (secret) {
          secretToTry = secret
          break
        }
      }
    }
  }

  // Path 2: If we couldn't find a secret via the event, try all calendar secrets
  if (!secretToTry) {
    const { data: allSecrets } = await supabase
      .from('calendars')
      .select('luma_webhook_secret')
      .not('luma_webhook_secret', 'is', null)

    if (!allSecrets || allSecrets.length === 0) {
      // No secrets configured anywhere — allow (graceful degradation)
      console.log('No webhook secrets configured on any calendar — skipping verification')
      return true
    }

    // Try each secret
    for (const row of allSecrets) {
      if (row.luma_webhook_secret && await hmacVerify(payload, signature, row.luma_webhook_secret)) {
        return true
      }
    }

    console.error('Webhook signature did not match any configured calendar secret')
    return false
  }

  return hmacVerify(payload, signature, secretToTry)
}

/**
 * Compute HMAC-SHA256 and compare against the provided signature
 */
async function hmacVerify(payload: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  const computed = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  // Constant-time comparison to prevent timing attacks
  if (computed.length !== signature.length) return false
  let mismatch = 0
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return mismatch === 0
}

/**
 * Extract ticket information from guest data
 */
function extractTicketInfo(data: LumaGuestData): { ticketType?: string; ticketAmount?: number; currency?: string } {
  // For ticket.registered, use the dedicated event_ticket field
  if (data.event_ticket) {
    return {
      ticketType: data.event_ticket.ticket_type_name,
      ticketAmount: data.event_ticket.amount,
      currency: data.event_ticket.currency || 'USD',
    }
  }

  // For guest.registered, check event_tickets array
  if (data.event_tickets?.length) {
    const ticket = data.event_tickets[0]
    return {
      ticketType: ticket.ticket_type_name,
      ticketAmount: ticket.amount,
      currency: ticket.currency || 'USD',
    }
  }

  // Check ticket orders for payment info
  if (data.event_ticket_orders?.length) {
    const order = data.event_ticket_orders[0]
    return {
      ticketAmount: order.amount,
      currency: order.currency || 'USD',
    }
  }

  return {}
}

/**
 * Handle guest.registered webhook event
 */
async function handleGuestRegistered(data: LumaGuestData): Promise<Response> {
  console.log('Processing guest.registered:', {
    guestId: data.id,
    userId: data.user_id,
    email: data.user_email,
    eventId: data.event?.api_id,
  })

  if (!data.user_email) {
    return new Response(JSON.stringify({
      success: false,
      error: 'No user email in webhook payload',
    }), {
      status: 200, // Return 200 to prevent retries
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const lumaEventId = data.event?.api_id
  if (!lumaEventId) {
    return new Response(JSON.stringify({
      success: false,
      error: 'No event ID in webhook payload',
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Look up event by luma_event_id
  const { data: event } = await supabase
    .from('events')
    .select('event_id, event_city, event_country_code, venue_address, cvent_event_id, cvent_admission_item_id, cvent_sync_enabled')
    .eq('luma_event_id', lumaEventId)
    .maybeSingle()

  // Look up per-event marketing consent setting
  let registrantMarketingConsent = false
  if (event) {
    const { data: commSettings } = await supabase
      .from('events_communication_settings')
      .select('registrant_marketing_consent')
      .eq('event_id', event.event_id)
      .maybeSingle()
    registrantMarketingConsent = commSettings?.registrant_marketing_consent === true
  }

  if (!event) {
    console.log(`No event found with luma_event_id: ${lumaEventId}`)
    // Store as pending registration for later processing
    await storePendingWebhookRegistration(data, 'guest.registered')
    return new Response(JSON.stringify({
      success: true,
      action: 'stored_pending',
      message: 'Registration stored - will be processed when event is added',
      lumaEventId,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const ticketInfo = extractTicketInfo(data)

  // Parse custom_source to extract tracking session ID
  // Format: {platform}__{session_id} e.g. "meta__ml5ddyhn-0er7obxy"
  let trackingSessionId: string | undefined
  if (data.custom_source?.includes('__')) {
    trackingSessionId = data.custom_source.split('__')[1]
  }

  const registrationData: RegistrationData = {
    email: data.user_email,
    firstName: data.user_first_name,
    lastName: data.user_last_name,
    fullName: data.user_name,
    phone: data.phone_number,
    lumaUserId: data.user_id,
    lumaGuestId: data.id,
    ticketType: ticketInfo.ticketType,
    ticketAmount: ticketInfo.ticketAmount,
    currency: ticketInfo.currency,
    approvalStatus: data.approval_status,
    registrationAnswers: data.registration_answers,
    registeredAt: data.registered_at,
    trackingSessionId,
  }

  const eventData: EventData = {
    eventId: event.event_id,
    eventCity: event.event_city,
    eventCountryCode: event.event_country_code,
    venueAddress: event.venue_address,
    cventEventId: event.cvent_sync_enabled ? event.cvent_event_id : null,
    cventAdmissionItemId: event.cvent_sync_enabled ? event.cvent_admission_item_id : null,
  }

  const result = await createFullRegistration(
    supabase,
    registrationData,
    eventData,
    customerioSiteId,
    customerioApiKey,
    registrantMarketingConsent
  )

  if (!result.success) {
    console.error('Failed to create registration:', result.error)
    return new Response(JSON.stringify({
      success: false,
      error: result.error,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  console.log('Registration created successfully:', {
    action: result.action,
    customerId: result.customerId,
    memberProfileId: result.memberProfileId,
    registrationId: result.registrationId,
  })

  // Conversion tracking is now handled by the DB trigger on event_registrations INSERT
  // (send_conversion_on_registration) — no need for fire-and-forget here.

  return new Response(JSON.stringify({
    success: true,
    action: result.action,
    email: data.user_email,
    lumaEventId,
    eventId: event.event_id,
    customerId: result.customerId,
    memberProfileId: result.memberProfileId,
    registrationId: result.registrationId,
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

/**
 * Handle ticket.registered webhook event
 * Similar to guest.registered but emphasizes payment details
 */
async function handleTicketRegistered(data: LumaGuestData): Promise<Response> {
  console.log('Processing ticket.registered:', {
    guestId: data.id,
    userId: data.user_id,
    email: data.user_email,
    eventId: data.event?.api_id,
    hasTicket: !!data.event_ticket,
  })

  // Delegate to guest.registered handler since the logic is the same
  // The ticket info extraction handles the event_ticket field automatically
  return handleGuestRegistered(data)
}

/**
 * Handle guest.updated webhook event
 * Handles approval status changes, cancellations, waitlist moves
 */
async function handleGuestUpdated(data: LumaGuestData): Promise<Response> {
  console.log('Processing guest.updated:', {
    guestId: data.id,
    userId: data.user_id,
    email: data.user_email,
    eventId: data.event?.api_id,
    approvalStatus: data.approval_status,
  })

  if (!data.user_email) {
    return new Response(JSON.stringify({
      success: false,
      error: 'No user email in webhook payload',
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const lumaEventId = data.event?.api_id
  if (!lumaEventId) {
    return new Response(JSON.stringify({
      success: false,
      error: 'No event ID in webhook payload',
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Look up event
  const { data: event } = await supabase
    .from('events')
    .select('event_id')
    .eq('luma_event_id', lumaEventId)
    .maybeSingle()

  if (!event) {
    console.log(`No event found with luma_event_id: ${lumaEventId}`)
    // Store for later processing
    await storePendingWebhookRegistration(data, 'guest.updated')
    return new Response(JSON.stringify({
      success: true,
      action: 'stored_pending',
      message: 'Update stored - will be processed when event is added',
      lumaEventId,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Map Luma approval status to our status
  const newStatus = mapApprovalStatus(data.approval_status)

  // Handle based on the new status
  if (newStatus === 'cancelled') {
    const result = await cancelRegistration(supabase, data.user_email, event.event_id)

    if (!result.success) {
      // If no registration found, it might not have been created yet
      // Store as pending for when it does get created
      if (result.error?.includes('No registration found')) {
        console.log('No registration to cancel - guest may not have been registered yet')
        return new Response(JSON.stringify({
          success: true,
          action: 'no_registration',
          message: 'No existing registration to cancel',
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      console.error('Failed to cancel registration:', result.error)
      return new Response(JSON.stringify({
        success: false,
        error: result.error,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log('Registration cancelled:', {
      registrationId: result.registrationId,
      previousStatus: result.previousStatus,
    })

    return new Response(JSON.stringify({
      success: true,
      action: 'cancelled',
      email: data.user_email,
      eventId: event.event_id,
      registrationId: result.registrationId,
      previousStatus: result.previousStatus,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // For other status changes (approved -> confirmed, pending_approval -> pending, waitlist)
  const result = await updateRegistrationStatus(
    supabase,
    data.user_email,
    event.event_id,
    newStatus
  )

  if (!result.success) {
    // If no registration found, create one (guest was likely just approved)
    if (result.error?.includes('No registration found') && newStatus === 'confirmed') {
      console.log('No existing registration - creating new one for approved guest')
      return handleGuestRegistered(data)
    }

    console.error('Failed to update registration:', result.error)
    return new Response(JSON.stringify({
      success: false,
      error: result.error,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  console.log('Registration status updated:', {
    registrationId: result.registrationId,
    previousStatus: result.previousStatus,
    newStatus,
  })

  return new Response(JSON.stringify({
    success: true,
    action: 'status_updated',
    email: data.user_email,
    eventId: event.event_id,
    registrationId: result.registrationId,
    previousStatus: result.previousStatus,
    newStatus,
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

/**
 * Store a pending webhook registration for later processing
 * This handles cases where the event doesn't exist in our system yet
 */
async function storePendingWebhookRegistration(
  data: LumaGuestData,
  webhookType: string
): Promise<void> {
  const ticketInfo = extractTicketInfo(data)

  try {
    // Check if we already have this pending registration
    const { data: existing } = await supabase
      .from('integrations_luma_pending_registrations')
      .select('id')
      .eq('luma_event_id', data.event?.api_id)
      .eq('matched_email', data.user_email?.toLowerCase())
      .maybeSingle()

    if (existing) {
      // Update existing record
      await supabase
        .from('integrations_luma_pending_registrations')
        .update({
          luma_user_id: data.user_id,
          user_name: data.user_name || `${data.user_first_name || ''} ${data.user_last_name || ''}`.trim(),
          status: data.approval_status === 'declined' ? 'cancelled' : 'no_event',
          registration_action: data.approval_status === 'declined' ? 'cancelled' : 'registered',
          raw_email_data: {
            webhook_type: webhookType,
            first_name: data.user_first_name,
            last_name: data.user_last_name,
            phone: data.phone_number,
            ticket_type: ticketInfo.ticketType,
            ticket_amount: ticketInfo.ticketAmount,
            approval_status: data.approval_status,
            registration_answers: data.registration_answers,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
    } else {
      // Insert new pending registration
      await supabase
        .from('integrations_luma_pending_registrations')
        .insert({
          luma_user_id: data.user_id,
          luma_event_id: data.event?.api_id,
          user_name: data.user_name || `${data.user_first_name || ''} ${data.user_last_name || ''}`.trim(),
          matched_email: data.user_email?.toLowerCase(),
          matched_via: 'webhook',
          status: 'no_event',
          registration_action: data.approval_status === 'declined' ? 'cancelled' : 'registered',
          email_received_at: new Date().toISOString(),
          raw_email_data: {
            webhook_type: webhookType,
            first_name: data.user_first_name,
            last_name: data.user_last_name,
            phone: data.phone_number,
            ticket_type: ticketInfo.ticketType,
            ticket_amount: ticketInfo.ticketAmount,
            approval_status: data.approval_status,
            registration_answers: data.registration_answers,
          },
        })
    }
  } catch (error) {
    console.error('Failed to store pending webhook registration:', error)
  }
}

async function handler(req: Request) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  try {
    // Get raw body for signature verification
    const rawBody = await req.text()
    const signature = req.headers.get('x-luma-signature')

    // Parse the webhook payload first so we can look up the secret by event
    const payload: LumaWebhookPayload = JSON.parse(rawBody)
    const lumaEventId = payload.data?.event?.api_id

    // Verify webhook signature
    if (!await verifyWebhookSignature(rawBody, signature, lumaEventId)) {
      console.error('Invalid webhook signature')
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid webhook signature',
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log('Received Luma webhook:', {
      type: payload.type,
      guestId: payload.data?.id,
      email: payload.data?.user_email,
      eventId: payload.data?.event?.api_id,
    })

    // Route to appropriate handler based on event type
    switch (payload.type) {
      case 'guest.registered':
        return handleGuestRegistered(payload.data)

      case 'ticket.registered':
        return handleTicketRegistered(payload.data)

      case 'guest.updated':
        return handleGuestUpdated(payload.data)

      default:
        console.log(`Unhandled webhook type: ${payload.type}`)
        return new Response(JSON.stringify({
          success: true,
          message: `Webhook type ${payload.type} acknowledged but not processed`,
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
    }
  } catch (error: any) {
    console.error('Error processing Luma webhook:', error)
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Internal server error'
    }), {
      status: 200, // Return 200 to prevent infinite retries
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
}

export default handler;
Deno.serve(handler);
