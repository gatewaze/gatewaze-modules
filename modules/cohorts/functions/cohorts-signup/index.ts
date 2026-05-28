import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { upsertCIOCustomer, isCIOConfigured } from '../_shared/customerio.ts'

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

interface SignupRequest {
  email: string
  user_metadata?: {
    first_name?: string
    last_name?: string
    company?: string
    job_title?: string
    full_name?: string
    avatar_url?: string
    provider?: string
  }
  source?: string
}

interface SignupResponse {
  success: boolean
  message: string
  person_id?: string
  cio_id?: string
  missing_fields?: string[]
  user_id?: string
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
    const body: SignupRequest = await req.json()
    const { email, user_metadata = {}, source = 'cohorts_signup' } = body

    if (!email) {
      return new Response(JSON.stringify({ error: 'Email required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`Processing signup for: ${email}`)
    console.log('User metadata:', user_metadata)

    // Step 1: Check if person already exists in Supabase
    const { data: existingPerson } = await supabase
      .from('people')
      .select('id, cio_id, email, auth_user_id, attributes')
      .ilike('email', email)
      .maybeSingle()

    if (existingPerson?.auth_user_id) {
      console.log(`Person already exists with auth: ${existingPerson.auth_user_id}`)

      // Update attributes if new metadata provided
      if (Object.keys(user_metadata).length > 0) {
        const updatedAttributes = {
          ...existingPerson.attributes,
          ...user_metadata
        }

        await supabase
          .from('people')
          .update({ attributes: updatedAttributes })
          .eq('id', existingPerson.id)

        // Update Customer.io
        if (isCIOConfigured) {
          await upsertCIOCustomer(existingPerson.cio_id, updatedAttributes)
        }
      }

      return new Response(JSON.stringify({
        success: true,
        message: 'Person already exists',
        person_id: existingPerson.id,
        cio_id: existingPerson.cio_id,
        user_id: existingPerson.auth_user_id
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Step 2: Generate CIO ID
    const cioId = `cohorts_${Date.now()}_${Math.random().toString(36).substring(7)}`

    // Step 3: Prepare attributes for Customer.io
    const attributes: Record<string, any> = {
      ...user_metadata,
      source,
      created_at: Math.floor(Date.now() / 1000),
      signup_platform: 'cohorts'
    }

    console.log('Creating person in Customer.io with ID:', cioId)

    // Step 4: Create person in Customer.io
    const cioSuccess = await upsertCIOCustomer(cioId, { email, ...attributes })
    if (!cioSuccess) {
      console.error('Failed to create person in Customer.io')
      throw new Error('Customer.io API error')
    }

    console.log('Person created in Customer.io successfully')

    // Step 5: Poll for person to appear in Supabase (webhook should create it)
    let person = null
    let attempts = 0
    const maxAttempts = 60 // 60 seconds

    while (attempts < maxAttempts && !person) {
      await new Promise(resolve => setTimeout(resolve, 1000))

      const { data } = await supabase
        .from('people')
        .select('id, cio_id, email, auth_user_id, attributes')
        .ilike('email', email)
        .maybeSingle()

      if (data?.auth_user_id) {
        person = data
        console.log(`Person found in Supabase after ${attempts + 1} seconds`)
        break
      }

      attempts++
      if (attempts % 5 === 0) {
        console.log(`Still waiting for webhook... attempt ${attempts}/${maxAttempts}`)
      }
    }

    if (!person) {
      console.error('Customer.io webhook did not create person within 60 seconds')
      return new Response(JSON.stringify({
        success: false,
        error: 'Timeout waiting for user creation',
        message: 'Please try again in a moment'
      }), {
        status: 408,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Step 6: Determine missing fields
    const requiredFields = ['first_name', 'last_name', 'company', 'job_title']
    const missingFields: string[] = []

    for (const field of requiredFields) {
      if (!person.attributes?.[field] && !user_metadata[field]) {
        missingFields.push(field)
      }
    }

    const response: SignupResponse = {
      success: true,
      message: missingFields.length > 0
        ? 'Additional information needed'
        : 'Signup complete',
      person_id: person.id,
      cio_id: person.cio_id,
      user_id: person.auth_user_id,
      missing_fields: missingFields
    }

    console.log('Signup response:', response)

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('Signup error:', error)
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      message: 'Signup failed'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
