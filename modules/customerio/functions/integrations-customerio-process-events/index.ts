import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { upsertCIOCustomer, trackCIOEvent, isCIOConfigured } from '../_shared/customerio.ts'

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

const BATCH_SIZE = 50

interface IntegrationEvent {
  id: string
  event_type: string
  payload: Record<string, unknown>
  status: string
  retry_count: number
  created_at: string
}

/**
 * Process a single integration event by dispatching to the appropriate CIO handler.
 */
async function processEvent(event: IntegrationEvent): Promise<boolean> {
  const { event_type, payload } = event
  const email = payload.email as string
  if (!email) {
    console.error(`[cio-process] Event ${event.id} missing email in payload`)
    return false
  }

  switch (event_type) {
    case 'person.created':
    case 'person.updated':
    case 'person.enriched': {
      const attributes = (payload.attributes || {}) as Record<string, unknown>
      // Clean attributes: remove nulls and truncate long strings
      const cleaned: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(attributes)) {
        if (value === null || value === undefined) continue
        if (typeof value === 'string' && value.length > 1000) {
          cleaned[key] = value.slice(0, 1000)
        } else if (Array.isArray(value)) {
          const jsonStr = JSON.stringify(value)
          if (jsonStr.length <= 1000) cleaned[key] = value
        } else {
          cleaned[key] = value
        }
      }
      return await upsertCIOCustomer(email, cleaned)
    }

    case 'person.subscribed': {
      const listId = payload.list_id as string
      const subscribed = payload.subscribed as boolean
      return await upsertCIOCustomer(email, {
        [`subscription_${listId}`]: subscribed,
      })
    }

    case 'event.registered': {
      const eventData = { ...payload }
      delete eventData.email
      eventData.timestamp = Math.floor(Date.now() / 1000)
      return await trackCIOEvent(email, 'event_registered', eventData)
    }

    default:
      console.warn(`[cio-process] Unknown event type: ${event_type}`)
      return false
  }
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

  if (!isCIOConfigured) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Customer.io not configured (missing CUSTOMERIO_SITE_ID or CUSTOMERIO_API_KEY)',
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    // Fetch pending events
    const { data: events, error: fetchError } = await supabase
      .from('integration_events')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE)

    if (fetchError) {
      console.error('[cio-process] Failed to fetch events:', fetchError)
      return new Response(JSON.stringify({ success: false, error: fetchError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!events || events.length === 0) {
      return new Response(JSON.stringify({ success: true, processed: 0, message: 'No pending events' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    console.log(`[cio-process] Processing ${events.length} pending events`)

    // Mark batch as processing
    const eventIds = events.map((e: IntegrationEvent) => e.id)
    await supabase
      .from('integration_events')
      .update({ status: 'processing' })
      .in('id', eventIds)

    let completed = 0
    let failed = 0

    for (const event of events as IntegrationEvent[]) {
      try {
        const ok = await processEvent(event)
        if (ok) {
          await supabase
            .from('integration_events')
            .update({ status: 'completed', processed_at: new Date().toISOString() })
            .eq('id', event.id)
          completed++
        } else {
          const newRetry = event.retry_count + 1
          await supabase
            .from('integration_events')
            .update({
              status: newRetry >= 3 ? 'failed' : 'pending',
              retry_count: newRetry,
            })
            .eq('id', event.id)
          failed++
        }
      } catch (err) {
        console.error(`[cio-process] Error processing event ${event.id}:`, err)
        const newRetry = event.retry_count + 1
        await supabase
          .from('integration_events')
          .update({
            status: newRetry >= 3 ? 'failed' : 'pending',
            retry_count: newRetry,
          })
          .eq('id', event.id)
        failed++
      }
    }

    console.log(`[cio-process] Done: ${completed} completed, ${failed} failed`)

    return new Response(JSON.stringify({
      success: true,
      processed: events.length,
      completed,
      failed,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('[cio-process] Error:', error)
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
