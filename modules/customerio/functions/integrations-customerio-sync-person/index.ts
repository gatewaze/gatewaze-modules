/**
 * Sync Person to Customer.io
 *
 * This edge function is called by a database trigger when the people table is updated.
 * It syncs the person attributes to Customer.io and updates last_synced_at in Supabase.
 *
 * Expected payload from pg_net trigger:
 * {
 *   email: string,
 *   attributes: Record<string, any>,
 *   source?: string  // 'db_trigger' when called from database
 * }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Customer.io Track API configuration
const CIO_TRACK_SITE_ID = Deno.env.get('CUSTOMERIO_SITE_ID')
const CIO_TRACK_API_KEY = Deno.env.get('CUSTOMERIO_API_KEY')

// Supabase client for updating last_synced_at
const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

interface SyncRequest {
  email: string
  attributes: Record<string, any>
  source?: string
}

/**
 * Update customer in Customer.io
 */
async function updateCIOCustomer(email: string, attributes: Record<string, any>): Promise<{ success: boolean; error?: string }> {
  if (!CIO_TRACK_SITE_ID || !CIO_TRACK_API_KEY) {
    console.log('Customer.io credentials not configured, skipping CIO update')
    return { success: false, error: 'CIO credentials not configured' }
  }

  try {
    const credentials = btoa(`${CIO_TRACK_SITE_ID}:${CIO_TRACK_API_KEY}`)

    // Use Customer.io Track API to update customer attributes
    // https://customer.io/docs/api/track/#operation/identify
    const response = await fetch(`https://track.customer.io/api/v1/customers/${encodeURIComponent(email)}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        ...attributes
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`CIO update failed: ${response.status} ${response.statusText} - ${errorText}`)
      return { success: false, error: `CIO API error: ${response.status}` }
    }

    console.log(`✅ CIO customer updated: ${email} with attributes: ${Object.keys(attributes).join(', ')}`)
    return { success: true }
  } catch (error) {
    console.error('Failed to update CIO customer:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Only accept POST requests
    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ success: false, error: 'Method not allowed' }),
        { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Parse request body
    const body: SyncRequest = await req.json()
    const { email, attributes, source } = body

    // Validate required fields
    if (!email) {
      return new Response(
        JSON.stringify({ success: false, error: 'Email is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!attributes || Object.keys(attributes).length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Attributes are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`📤 Syncing person to CIO: ${email} (source: ${source || 'unknown'})`)
    console.log(`   Attributes: ${JSON.stringify(attributes)}`)

    // Sync to Customer.io
    const result = await updateCIOCustomer(email, attributes)

    // Update last_synced_at in Supabase if sync was successful
    if (result.success) {
      try {
        const supabase = createClient(supabaseUrl, supabaseServiceKey, {
          auth: {
            autoRefreshToken: false,
            persistSession: false
          }
        })

        const { error: updateError } = await supabase
          .from('people')
          .update({ last_synced_at: new Date().toISOString() })
          .ilike('email', email)

        if (updateError) {
          console.error('Failed to update last_synced_at:', updateError)
        } else {
          console.log(`✅ Updated last_synced_at for ${email}`)
        }
      } catch (dbError) {
        console.error('Error updating last_synced_at:', dbError)
        // Don't fail the response - CIO sync was successful
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Person synced to Customer.io',
          email,
          attributes_synced: Object.keys(attributes)
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } else {
      return new Response(
        JSON.stringify({
          success: false,
          error: result.error,
          email
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

  } catch (error) {
    console.error('Error in sync-person-to-cio function:', error)
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to sync person to CIO',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }
})
