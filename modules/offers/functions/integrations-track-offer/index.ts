import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface TrackOfferInteractionRequest {
  email: string
  offer_id: string
  offer_status: 'viewed' | 'accepted' | 'completed'
  offer_type?: string
  offer_partner?: string
  offer_referrer?: string
  workspace?: string
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
    const body: TrackOfferInteractionRequest = await req.json()
    const { email, offer_id, offer_status, offer_type, offer_partner, workspace } = body

    // Validate required fields
    if (!email || !offer_id || !offer_status) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Missing required fields: email, offer_id, and offer_status are required'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validate offer_status
    const validStatuses = ['viewed', 'accepted', 'completed']
    if (!validStatuses.includes(offer_status)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Invalid offer_status. Must be one of: ${validStatuses.join(', ')}`
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Create Supabase client with service role key for full access
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    )

    console.log(`📊 Tracking offer interaction: ${offer_id} - ${offer_status} for ${email}`)

    // Step 1: Look up the person by email to get their id and cio_id
    const { data: person, error: personError } = await supabaseClient
      .from('people')
      .select('id, cio_id, email')
      .eq('email', email.toLowerCase())
      .single()

    if (personError || !person) {
      // Person not found - cannot track interaction without a person record
      console.log(`⚠️ Person not found for ${email}`)
      return new Response(
        JSON.stringify({
          success: false,
          error: `Person not found for email: ${email}`
        }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`✅ Found person with id: ${person.id}, cio_id: ${person.cio_id}`)

    // Step 2: Insert the offer interaction record
    // Use customer_id as the primary foreign key, keep customer_cio_id for backward compatibility
    const normalizedEmail = email.toLowerCase().trim()
    const { data: interaction, error: insertError } = await supabaseClient
      .from('integrations_offer_interactions')
      .insert([{
        customer_id: person.id,
        customer_cio_id: person.cio_id,
        email: normalizedEmail,
        offer_id: offer_id,
        offer_status: offer_status,
        offer_type: offer_type || null,
        offer_partner: offer_partner || null,
        offer_referrer: 'api',
        workspace: workspace || null,
        timestamp: new Date().toISOString()
      }])
      .select()
      .single()

    if (insertError) {
      // Check for duplicate entry (unique constraint violation)
      if (insertError.code === '23505') {
        console.log(`⚠️ Duplicate interaction: ${offer_id} - ${offer_status} for ${person.cio_id}`)
        return new Response(
          JSON.stringify({
            success: true,
            message: 'Interaction already recorded',
            duplicate: true
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      console.error('❌ Error inserting offer interaction:', insertError)
      throw insertError
    }

    console.log(`✅ Successfully tracked offer interaction: ${interaction?.id}`)

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Offer interaction tracked successfully',
        interaction_id: interaction?.id,
        person_id: person.id,
        customer_cio_id: person.cio_id
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('❌ Error in track-offer-interaction function:', error)
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || 'Failed to track offer interaction',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }
})
