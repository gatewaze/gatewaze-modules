import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { syncRegistrantToCvent, listAdmissionItems, updateCventContact } from '../_shared/cventApi.ts'

/**
 * Cvent Sync Edge Function
 *
 * Handles two operations:
 *
 * POST /cvent-sync
 *   { "event_id": "b68wjx" }
 *   → Backfills ALL confirmed registrants for this Gatewaze event to Cvent.
 *
 *   { "registration_id": "uuid" }
 *   → Syncs a single registration to Cvent (called from lumaRegistration.ts).
 *
 * GET /cvent-sync?event_id=b68wjx&action=admission-items
 *   → Returns admission items for the Cvent event (used by the admin UI dropdown).
 *
 * Required Supabase secrets:
 *   CVENT_CLIENT_ID
 *   CVENT_CLIENT_SECRET
 */

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const cventClientId = Deno.env.get('CVENT_CLIENT_ID')!
const cventClientSecret = Deno.env.get('CVENT_CLIENT_SECRET')!

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------
// Fetch Cvent config for a Gatewaze event
// ---------------------------------------------------------------------------
async function getCventConfig(eventId: string) {
  const { data, error } = await supabase
    .from('events')
    .select('cvent_event_id, cvent_admission_item_id, cvent_sync_enabled')
    .eq('event_id', eventId)
    .maybeSingle()

  if (error || !data) return null
  return data as {
    cvent_event_id: string | null
    cvent_admission_item_id: string | null
    cvent_sync_enabled: boolean
  }
}

// ---------------------------------------------------------------------------
// Backfill all registrants for a Gatewaze event
// ---------------------------------------------------------------------------
async function backfillEvent(eventId: string): Promise<Response> {
  const config = await getCventConfig(eventId)
  if (!config?.cvent_event_id) {
    return json({ success: false, error: 'Event has no cvent_event_id configured' }, 400)
  }
  if (!config.cvent_admission_item_id) {
    return json({ success: false, error: 'Event has no cvent_admission_item_id configured — set it in the admin UI first' }, 400)
  }

  if (!cventClientId || !cventClientSecret) {
    return json({ success: false, error: 'CVENT_CLIENT_ID / CVENT_CLIENT_SECRET secrets not set' }, 500)
  }

  // Fetch all confirmed/non-cancelled registrations with customer email + name
  const { data: registrations, error: regError } = await supabase
    .from('event_registrations')
    .select(`
      id,
      status,
      member_profiles!inner(
        customers!inner(email, attributes)
      )
    `)
    .eq('event_id', eventId)
    .in('status', ['confirmed', 'pending', 'waitlist'])

  if (regError) {
    return json({ success: false, error: `DB error: ${regError.message}` }, 500)
  }

  if (!registrations || registrations.length === 0) {
    return json({ success: true, synced: 0, errors: [], message: 'No registrations to sync' })
  }

  console.log(`Backfilling ${registrations.length} registrants for event ${eventId} → Cvent ${config.cvent_event_id}`)

  const results = { synced: 0, already_exists: 0, errors: [] as string[] }

  // Process sequentially with a delay to avoid Cvent rate limits.
  // The backfill is idempotent — re-run to continue where it left off.
  for (const reg of registrations) {
    const customer = (reg as any).member_profiles?.customers
    if (!customer?.email) {
      results.errors.push(`Registration ${reg.id}: no email found`)
      continue
    }

    const attrs = (customer.attributes || {}) as Record<string, any>
    const result = await syncRegistrantToCvent(
      cventClientId,
      cventClientSecret,
      config.cvent_event_id!,
      config.cvent_admission_item_id!,
      customer.email,
      attrs.first_name,
      attrs.last_name,
      attrs.job_title,
      attrs.company
    )

    if (result.success) {
      if (result.action === 'already_exists') {
        results.already_exists++
      } else {
        results.synced++
      }
    } else {
      results.errors.push(`${customer.email}: ${result.error}`)
    }

    // Small delay between registrants to stay under Cvent rate limits
    await new Promise(r => setTimeout(r, 500))
  }

  return json({
    success: true,
    ...results,
    total: registrations.length,
    message: `Synced ${results.synced} new, ${results.already_exists} already existed, ${results.errors.length} errors`,
  })
}

// ---------------------------------------------------------------------------
// Sync a single registration by ID
// ---------------------------------------------------------------------------
async function syncSingleRegistration(registrationId: string, force = false): Promise<Response> {
  // Fetch registration with event config and customer details
  const { data: reg, error } = await supabase
    .from('event_registrations')
    .select(`
      id,
      event_id,
      status,
      member_profiles!inner(
        customers!inner(email, attributes)
      )
    `)
    .eq('id', registrationId)
    .maybeSingle()

  if (error || !reg) {
    return json({ success: false, error: `Registration not found: ${registrationId}` }, 404)
  }

  const config = await getCventConfig(reg.event_id)
  // force=true allows manual test syncs even when live sync is disabled
  if (!config?.cvent_event_id || !config.cvent_admission_item_id) {
    return json({ success: false, error: 'Event has no cvent_event_id or cvent_admission_item_id configured' }, 400)
  }
  if (!force && !config.cvent_sync_enabled) {
    return json({ success: true, skipped: true, reason: 'Cvent sync not enabled for this event' })
  }

  if (!cventClientId || !cventClientSecret) {
    return json({ success: false, error: 'CVENT_CLIENT_ID / CVENT_CLIENT_SECRET secrets not set' }, 500)
  }

  const customer = (reg as any).member_profiles?.customers
  if (!customer?.email) {
    return json({ success: false, error: 'No email on registration' }, 400)
  }

  const attrs = (customer.attributes || {}) as Record<string, any>
  const result = await syncRegistrantToCvent(
    cventClientId,
    cventClientSecret,
    config.cvent_event_id,
    config.cvent_admission_item_id,
    customer.email,
    attrs.first_name,
    attrs.last_name,
    attrs.job_title,
    attrs.company
  )

  return json(result)
}

// ---------------------------------------------------------------------------
// Update a Cvent contact when customer attributes change (real-time sync)
// Called by DB trigger on customers table
// ---------------------------------------------------------------------------
async function handleUpdateContact(customerId: number): Promise<Response> {
  if (!cventClientId || !cventClientSecret) {
    return json({ success: false, error: 'CVENT_CLIENT_ID / CVENT_CLIENT_SECRET secrets not set' }, 500)
  }

  // Check if this customer has any registrations for Cvent-enabled events
  const { data: registrations, error: regError } = await supabase
    .from('event_registrations')
    .select(`
      event_id,
      events!inner(cvent_event_id, cvent_sync_enabled),
      member_profiles!inner(customer_id)
    `)
    .eq('member_profiles.customer_id', customerId)
    .eq('events.cvent_sync_enabled', true)
    .not('events.cvent_event_id', 'is', null)
    .in('status', ['confirmed', 'pending', 'waitlist'])
    .limit(1)

  if (regError) {
    console.log(`update-contact: DB error for customer ${customerId}: ${regError.message}`)
    return json({ success: false, error: regError.message }, 500)
  }

  if (!registrations || registrations.length === 0) {
    // Customer is not registered for any Cvent-enabled events, skip
    return json({ success: true, skipped: true, reason: 'No Cvent-enabled event registrations' })
  }

  // Fetch customer details
  const { data: customer, error: custError } = await supabase
    .from('customers')
    .select('email, attributes')
    .eq('id', customerId)
    .single()

  if (custError || !customer?.email) {
    return json({ success: false, error: 'Customer not found' }, 404)
  }

  const attrs = (customer.attributes || {}) as Record<string, any>

  const result = await updateCventContact(
    cventClientId,
    cventClientSecret,
    customer.email,
    attrs.first_name,
    attrs.last_name,
    attrs.job_title,
    attrs.company
  )

  // Update last_synced_at on success
  if (result.success) {
    await supabase
      .from('customers')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('id', customerId)
  }

  return json(result)
}

// ---------------------------------------------------------------------------
// List admission items for a Gatewaze event (admin UI)
// ---------------------------------------------------------------------------
async function handleAdmissionItems(eventId: string): Promise<Response> {
  const config = await getCventConfig(eventId)
  if (!config?.cvent_event_id) {
    return json({ success: false, error: 'Event has no cvent_event_id configured' }, 400)
  }

  if (!cventClientId || !cventClientSecret) {
    return json({ success: false, error: 'CVENT_CLIENT_ID / CVENT_CLIENT_SECRET secrets not set' }, 500)
  }

  const result = await listAdmissionItems(cventClientId, cventClientSecret, config.cvent_event_id)
  return json(result)
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const url = new URL(req.url)

  try {
    if (req.method === 'GET') {
      const eventId = url.searchParams.get('event_id')
      const action = url.searchParams.get('action')

      if (!eventId) return json({ success: false, error: 'event_id required' }, 400)
      if (action === 'admission-items') return handleAdmissionItems(eventId)

      return json({ success: false, error: 'Unknown action' }, 400)
    }

    if (req.method === 'POST') {
      const body = await req.json()

      // Admission items lookup (from admin UI — uses POST since supabase.functions.invoke is always POST)
      if (body.action === 'admission-items' && body.event_id) {
        return handleAdmissionItems(body.event_id)
      }

      // Update contact from DB trigger (real-time sync)
      if (body.action === 'update-contact' && body.customer_id) {
        return handleUpdateContact(body.customer_id)
      }

      // Backfill all registrants for an event
      if (body.event_id && !body.action) {
        return backfillEvent(body.event_id)
      }

      // Sync a single registration — force=true skips the cvent_sync_enabled check (for testing)
      if (body.registration_id) {
        return syncSingleRegistration(body.registration_id, body.force === true)
      }

      return json({ success: false, error: 'event_id or registration_id required' }, 400)
    }

    return json({ success: false, error: 'Method not allowed' }, 405)
  } catch (err: any) {
    console.error('cvent-sync error:', err)
    return json({ success: false, error: err.message || 'Internal error' }, 500)
  }
})
