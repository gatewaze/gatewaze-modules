import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { upsertCIOCustomer, lookupCIOId } from '../_shared/customerio.ts'

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
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface CohortInterestRequest {
  email: string
  cohort_id: string
  interaction_type: 'interested' | 'waitlist' | 'enrolled' | 'completed'
  metadata?: Record<string, any>
}

interface CohortInterestResponse {
  success: boolean
  message: string
  interaction_id?: string
  person_id?: string
  error?: string
}

Deno.serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  try {
    const body: CohortInterestRequest = await req.json()
    const { email, cohort_id, interaction_type, metadata = {} } = body

    if (!email) {
      return new Response(JSON.stringify({ error: 'Email required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!cohort_id) {
      return new Response(JSON.stringify({ error: 'Cohort ID required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!interaction_type) {
      return new Response(JSON.stringify({ error: 'Interaction type required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const validTypes = ['interested', 'waitlist', 'enrolled', 'completed']
    if (!validTypes.includes(interaction_type)) {
      return new Response(JSON.stringify({
        error: `Invalid interaction type. Must be one of: ${validTypes.join(', ')}`
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`Processing cohort interest for: ${email}, cohort: ${cohort_id}, type: ${interaction_type}`)

    const normalizedEmail = email.toLowerCase()
    let personId: string | null = null

    // For waitlist signups, create person in Customer.io and Supabase
    if (interaction_type === 'waitlist') {
      console.log('Waitlist signup - creating person...')
      personId = await ensurePersonExists(normalizedEmail, cohort_id, metadata)
    } else {
      // For other interactions, just look up the person
      const { data: existingPerson } = await supabase
        .from('people')
        .select('id')
        .ilike('email', normalizedEmail)
        .maybeSingle()

      personId = existingPerson?.id?.toString() || null
    }

    console.log('Person ID:', personId)

    // Upsert the interaction record
    const { data: interaction, error: upsertError } = await supabase
      .from('cohorts_interactions')
      .upsert({
        cohort_id,
        email: normalizedEmail,
        customer_id: personId ? parseInt(personId) : null,
        interaction_type,
        metadata,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'email,cohort_id,interaction_type'
      })
      .select('id')
      .single()

    if (upsertError) {
      console.error('Error upserting cohort interaction:', upsertError)
      return new Response(JSON.stringify({
        success: false,
        error: upsertError.message,
        message: 'Failed to save cohort interest'
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log('Cohort interaction saved:', interaction?.id)

    const response: CohortInterestResponse = {
      success: true,
      message: interaction_type === 'waitlist'
        ? 'Successfully added to waitlist'
        : 'Cohort interest recorded',
      interaction_id: interaction?.id,
      person_id: personId || undefined
    }

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('Cohort interest error:', error)
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      message: 'Failed to process cohort interest'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})

/**
 * Ensure a person exists in Customer.io and Supabase
 * Creates the person if they don't exist
 */
async function ensurePersonExists(
  email: string,
  cohortId: string,
  metadata: Record<string, any>
): Promise<string | null> {
  try {
    // Check if person already exists in Supabase
    const { data: existingPerson } = await supabase
      .from('people')
      .select('id, cio_id, auth_user_id')
      .ilike('email', email)
      .maybeSingle()

    if (existingPerson) {
      console.log('Person already exists:', existingPerson.id)
      return existingPerson.id.toString()
    }

    console.log('Creating new person for waitlist signup:', email)

    // Prepare attributes for Customer.io
    const attributes: Record<string, any> = {
      ...metadata,
      source: 'cohorts_waitlist',
      signup_source: 'cohorts_waitlist',
      signup_platform: 'cohorts',
      cohort_waitlist_id: cohortId,
      created_at: Math.floor(Date.now() / 1000),
    }

    // Create person in Customer.io Track API (using email as ID)
    const cioSuccess = await upsertCIOCustomer(email, { email, ...attributes })
    if (cioSuccess) {
      console.log('Person created in Customer.io Track API successfully')
    } else {
      console.error('Failed to create person in Customer.io')
      // Continue anyway - we can still create the Supabase record
    }

    // Wait a moment for Customer.io to index
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Fetch the cio_id from Customer.io App API
    let cioId: string | null = await lookupCIOId(email)
    if (cioId) {
      console.log('Retrieved cio_id from Customer.io:', cioId)
    }

    // Generate fallback cio_id if needed
    if (!cioId) {
      const timestamp = Date.now().toString(16)
      const random = Math.random().toString(16).substring(2, 15)
      cioId = (timestamp + random).substring(0, 20)
      console.log('Generated fallback cio_id:', cioId)
    }

    // Create auth user in Supabase
    let authUserId: string | null = null
    try {
      const { data: newAuthUser, error: createError } = await supabase.auth.admin.createUser({
        email: email,
        email_confirm: false, // They'll need to verify via magic link when they sign in
      })

      if (createError) {
        console.error('Failed to create auth user:', createError)
      } else if (newAuthUser.user) {
        authUserId = newAuthUser.user.id
        console.log('Created auth user with ID:', authUserId)
      }
    } catch (error) {
      console.error('Error creating auth user:', error)
    }

    // Create person record in Supabase
    const { data: newPerson, error: insertError } = await supabase
      .from('people')
      .insert({
        cio_id: cioId,
        email: email,
        auth_user_id: authUserId,
        attributes: attributes,
        last_synced_at: new Date().toISOString()
      })
      .select('id')
      .single()

    if (insertError) {
      console.error('Error creating person record:', insertError)
      return null
    }

    console.log('Person record created in Supabase:', newPerson.id)
    return newPerson.id.toString()

  } catch (error) {
    console.error('Error ensuring person exists:', error)
    return null
  }
}
