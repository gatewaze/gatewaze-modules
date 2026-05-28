import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { trackCIOEvent } from '../_shared/customerio.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// API key for authenticating requests from the frontend
const API_BEARER_TOKEN = Deno.env.get('GW_API_BEARER') || 'YYv8gvrl55fVPmJDQAWz8JLmhtpZpWF1MlqOrv8dfs7yPfMHPLHTdAlUeJcDiIUe'

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

interface TrackEventRequest {
  email: string
  type: string // Must be 'track'
  event: string // Event name
  properties: Record<string, any>
  timestamp?: string // ISO timestamp
}

/**
 * Store event in Supabase customer_events table
 */
async function storeEventInSupabase(
  email: string,
  eventName: string,
  eventData: Record<string, any>,
  timestamp: Date
): Promise<{ success: boolean; error?: string }> {
  try {
    // First, get the person's id and cio_id (required for foreign key)
    const { data: person, error: personError } = await supabase
      .from('people')
      .select('id, cio_id')
      .ilike('email', email)
      .maybeSingle()

    if (personError) {
      console.error('Error fetching person:', personError)
      return { success: false, error: personError.message }
    }

    if (!person) {
      // Person doesn't exist in our database yet
      // We could create them, but for now just log and continue
      console.log(`Person not found in Supabase for email: ${email}. Skipping Supabase storage.`)
      return { success: false, error: 'Person not found in Supabase' }
    }

    // Generate a unique event ID
    const eventId = `${email.replace('@', '_at_')}_${eventName}_${timestamp.getTime()}`

    // Insert the event with customer_id as primary FK, keep customer_cio_id for backward compatibility
    const { error: insertError } = await supabase
      .from('integrations_customerio_events')
      .insert({
        customer_id: person.id,
        customer_cio_id: person.cio_id,
        event_id: eventId,
        event_name: eventName,
        event_data: eventData,
        timestamp: timestamp.toISOString(),
      })

    if (insertError) {
      console.error('Error inserting event:', insertError)
      return { success: false, error: insertError.message }
    }

    return { success: true }
  } catch (error) {
    console.error('Error storing event in Supabase:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Only POST method is allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Validate Authorization header
  const authHeader = req.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== API_BEARER_TOKEN) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    const body: TrackEventRequest = await req.json()

    // Validate required fields
    const requiredFields = ['email', 'type', 'event', 'properties']
    for (const field of requiredFields) {
      if (!(field in body)) {
        return new Response(JSON.stringify({ error: `${field} is required` }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }

    // Ensure type is 'track'
    if (body.type !== 'track') {
      return new Response(JSON.stringify({ error: 'type must be "track"' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { email, event: eventName, properties } = body

    // Parse timestamp if provided, otherwise use current time
    let timestamp: Date
    if (body.timestamp) {
      timestamp = new Date(body.timestamp)
      if (isNaN(timestamp.getTime())) {
        return new Response(JSON.stringify({ error: 'Invalid timestamp format' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    } else {
      timestamp = new Date()
    }

    // Add timestamp to properties for Customer.io
    const propertiesWithTimestamp = {
      ...properties,
      timestamp: Math.floor(timestamp.getTime() / 1000), // Unix timestamp in seconds
    }

    // Prepare complete event data for Supabase
    const completeEventData = {
      email,
      event: eventName,
      type: body.type,
      properties,
      original_request: body,
      processed_at: new Date().toISOString(),
    }

    // Track in Customer.io
    const cioOk = await trackCIOEvent(email, eventName, propertiesWithTimestamp)
    const cioResult = { success: cioOk, error: cioOk ? null : 'CIO tracking failed or not configured' }

    // Store in Supabase
    const supabaseResult = await storeEventInSupabase(email, eventName, completeEventData, timestamp)

    // Build response
    const response = {
      success: cioResult.success || supabaseResult.success,
      message: cioResult.success || supabaseResult.success
        ? 'Event tracked successfully'
        : 'Failed to track event to any destination',
      customer_io: {
        success: cioResult.success,
        error: cioResult.error || null,
      },
      supabase: {
        success: supabaseResult.success,
        error: supabaseResult.error || null,
      },
    }

    // Return success if at least one destination worked
    const statusCode = response.success ? 200 : 500

    return new Response(JSON.stringify(response), {
      status: statusCode,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('Track event error:', error)
    return new Response(JSON.stringify({
      error: 'Failed to track event',
      details: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
