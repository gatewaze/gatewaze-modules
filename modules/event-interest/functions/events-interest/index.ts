import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { upsertCIOCustomer, trackCIOEvent, lookupCIOId, isCIOConfigured } from '../_shared/customerio.ts'

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

interface EventInterestRequest {
  email: string
  event_id: string // Can be UUID or short event_id
  first_name?: string
  last_name?: string
  company?: string
  job_title?: string
  phone?: string
  linkedin_url?: string
  interest_type?: 'general' | 'speaker' | 'sponsor' | 'volunteer' | 'press' | 'vip'
  source?: string // Marketing source: linkedin, facebook, email_campaign, referral, website, partner, organic, ads
  referrer?: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  notes?: string
  metadata?: Record<string, any>
}

interface EventInterestResponse {
  success: boolean
  message: string
  interest_id?: string
  member_profile_id?: string
  person_id?: number
  already_interested?: boolean
  error?: string
}

Deno.serve(async (req) => {
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
    const body: EventInterestRequest = await req.json()
    const {
      email,
      event_id,
      first_name,
      last_name,
      company,
      job_title,
      phone,
      linkedin_url,
      interest_type = 'general',
      source,
      referrer,
      utm_source,
      utm_medium,
      utm_campaign,
      notes,
      metadata = {}
    } = body

    // Validate required fields
    if (!email) {
      return new Response(JSON.stringify({ success: false, error: 'Email is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!event_id) {
      return new Response(JSON.stringify({ success: false, error: 'Event ID is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid email format' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const normalizedEmail = email.toLowerCase().trim()
    console.log(`📝 Processing event interest for: ${normalizedEmail}, event: ${event_id}`)

    // Step 1: Verify event exists and get the short event_id
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    let eventQuery = supabase.from('events').select('id, event_id, event_title, enable_interest')

    if (uuidRegex.test(event_id)) {
      eventQuery = eventQuery.eq('id', event_id)
    } else {
      eventQuery = eventQuery.eq('event_id', event_id)
    }

    const { data: eventRecord, error: eventError } = await eventQuery.maybeSingle()

    if (eventError) {
      console.error('Error fetching event:', eventError)
      return new Response(JSON.stringify({ success: false, error: 'Failed to verify event' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!eventRecord) {
      return new Response(JSON.stringify({ success: false, error: `Event not found: ${event_id}` }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Check if interest registration is enabled for this event
    if (eventRecord.enable_interest === false) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Interest registration is not enabled for this event'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const resolvedEventId = eventRecord.event_id // Use short event_id
    console.log(`✅ Event verified: ${eventRecord.event_title} (${resolvedEventId})`)

    // Step 2: Check if already expressed interest
    const { data: existingInterest } = await supabase
      .from('events_interest')
      .select('id, status')
      .eq('event_id', resolvedEventId)
      .eq('email', normalizedEmail)
      .maybeSingle()

    if (existingInterest) {
      // If withdrawn, allow re-expressing interest
      if (existingInterest.status === 'withdrawn') {
        const { error: updateError } = await supabase
          .from('events_interest')
          .update({
            status: 'active',
            first_name,
            last_name,
            company,
            job_title,
            phone,
            linkedin_url,
            interest_type,
            source,
            referrer,
            utm_source,
            utm_medium,
            utm_campaign,
            notes,
            metadata,
            updated_at: new Date().toISOString()
          })
          .eq('id', existingInterest.id)

        if (updateError) {
          console.error('Error reactivating interest:', updateError)
          return new Response(JSON.stringify({ success: false, error: 'Failed to reactivate interest' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }

        return new Response(JSON.stringify({
          success: true,
          message: 'Interest reactivated for this event',
          interest_id: existingInterest.id,
          already_interested: false
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      console.log(`⚠️ Already interested: ${existingInterest.id}`)
      return new Response(JSON.stringify({
        success: true,
        message: 'Already expressed interest in this event',
        interest_id: existingInterest.id,
        already_interested: true
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Step 3: Try to find or create person (optional - interest can be expressed without full account)
    let memberProfileId: string | null = null
    let personId: number | null = null

    const personResult = await findOrCreatePerson(normalizedEmail, {
      first_name,
      last_name,
      company,
      job_title,
      phone,
      linkedin_url,
      source: 'event_interest'
    })

    if (personResult) {
      personId = personResult.id

      // Try to get or create member profile
      const memberProfile = await getOrCreateMemberProfile(personResult.id)
      if (memberProfile) {
        memberProfileId = memberProfile.id
      }
    }

    // Step 4: Create interest record
    // If source is not provided, fall back to utm_source
    const resolvedSource = source || utm_source || null

    const interestData: Record<string, any> = {
      event_id: resolvedEventId,
      email: normalizedEmail,
      people_profile_id: memberProfileId,
      first_name,
      last_name,
      company,
      job_title,
      phone,
      linkedin_url,
      interest_source: 'website',
      interest_type,
      status: 'active',
      source: resolvedSource,
      referrer,
      utm_source,
      utm_medium,
      utm_campaign,
      notes,
      metadata,
      expressed_at: new Date().toISOString()
    }

    const { data: interest, error: interestError } = await supabase
      .from('events_interest')
      .insert(interestData)
      .select('id')
      .single()

    if (interestError) {
      console.error('Error creating interest:', interestError)
      return new Response(JSON.stringify({
        success: false,
        error: `Failed to create interest: ${interestError.message}`
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`✅ Interest created: ${interest.id}`)

    // Step 5: Track event in Customer.io (non-blocking)
    if (isCIOConfigured) {
      trackCIOEvent(normalizedEmail, 'event_interest_expressed', {
        event_id: resolvedEventId,
        event_title: eventRecord.event_title,
        interest_type,
        interest_source: 'website'
      }).catch(err => console.error('Failed to track CIO event:', err))
    }

    const response: EventInterestResponse = {
      success: true,
      message: 'Successfully expressed interest in event',
      interest_id: interest.id,
      member_profile_id: memberProfileId || undefined,
      person_id: personId || undefined,
      already_interested: false
    }

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('❌ Event interest error:', error)
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})

/**
 * Find existing person or create new one
 */
async function findOrCreatePerson(
  email: string,
  attributes: Record<string, any>
): Promise<{ id: number; cio_id: string } | null> {
  try {
    // Check if person already exists
    const { data: existingPerson } = await supabase
      .from('people')
      .select('id, cio_id')
      .ilike('email', email)
      .maybeSingle()

    if (existingPerson) {
      console.log('Person exists:', existingPerson.id)

      // Update attributes in Customer.io if we have new data
      if (isCIOConfigured && existingPerson.cio_id && (attributes.first_name || attributes.last_name || attributes.company)) {
        const updateAttrs: Record<string, any> = {}
        if (attributes.first_name) updateAttrs.first_name = attributes.first_name
        if (attributes.last_name) updateAttrs.last_name = attributes.last_name
        if (attributes.company) updateAttrs.company = attributes.company
        if (attributes.job_title) updateAttrs.job_title = attributes.job_title
        if (attributes.phone) updateAttrs.phone = attributes.phone
        if (attributes.linkedin_url) updateAttrs.linkedin_url = attributes.linkedin_url
        if (Object.keys(updateAttrs).length > 0) {
          upsertCIOCustomer(existingPerson.cio_id, updateAttrs).catch(err =>
            console.error('Failed to update CIO attributes:', err)
          )
        }
      }

      return existingPerson
    }

    console.log('Creating new person:', email)

    // Prepare attributes for Customer.io
    const cioAttributes: Record<string, any> = {
      email,
      source: attributes.source || 'event_interest',
      signup_source: 'event_interest',
      created_at: Math.floor(Date.now() / 1000),
    }

    // Add profile fields if provided
    if (attributes.first_name) cioAttributes.first_name = attributes.first_name
    if (attributes.last_name) cioAttributes.last_name = attributes.last_name
    if (attributes.company) cioAttributes.company = attributes.company
    if (attributes.job_title) cioAttributes.job_title = attributes.job_title
    if (attributes.phone) cioAttributes.phone = attributes.phone
    if (attributes.linkedin_url) cioAttributes.linkedin_url = attributes.linkedin_url

    // Create person in Customer.io (using email as identifier)
    const cioSuccess = await upsertCIOCustomer(email, cioAttributes)
    if (cioSuccess) {
      console.log('Person created in Customer.io')
    } else {
      console.error('Failed to create person in Customer.io')
    }

    // Wait for Customer.io to index
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Try to get cio_id from Customer.io App API
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

    // Create auth user
    let authUserId: string | null = null
    try {
      const { data: newAuthUser, error: createError } = await supabase.auth.admin.createUser({
        email: email,
        email_confirm: false,
      })

      if (createError) {
        console.error('Failed to create auth user:', createError)
      } else if (newAuthUser.user) {
        authUserId = newAuthUser.user.id
        console.log('Created auth user:', authUserId)
      }
    } catch (error) {
      console.error('Error creating auth user:', error)
    }

    // Create person record in Supabase
    const personAttributes: Record<string, any> = {}
    if (attributes.first_name) personAttributes.first_name = attributes.first_name
    if (attributes.last_name) personAttributes.last_name = attributes.last_name
    if (attributes.company) personAttributes.company = attributes.company
    if (attributes.job_title) personAttributes.job_title = attributes.job_title
    if (attributes.phone) personAttributes.phone = attributes.phone
    if (attributes.linkedin_url) personAttributes.linkedin_url = attributes.linkedin_url

    const { data: newPerson, error: insertError } = await supabase
      .from('people')
      .insert({
        cio_id: cioId,
        email: email,
        auth_user_id: authUserId,
        attributes: personAttributes,
        last_synced_at: new Date().toISOString()
      })
      .select('id, cio_id')
      .single()

    if (insertError) {
      console.error('Error creating person:', insertError)
      return null
    }

    console.log('Person created in Supabase:', newPerson.id)
    return newPerson

  } catch (error) {
    console.error('Error in findOrCreatePerson:', error)
    return null
  }
}

/**
 * Get or create member profile for person
 */
async function getOrCreateMemberProfile(personId: number): Promise<{ id: string } | null> {
  try {
    // Use the RPC function that handles QR code generation
    const { data: memberProfileId, error: rpcError } = await supabase
      .rpc('people_get_or_create_profile', {
        p_person_id: personId,
      })

    if (rpcError) {
      console.error('Error creating member profile:', rpcError)
      return null
    }

    return { id: memberProfileId }
  } catch (error) {
    console.error('Error in getOrCreateMemberProfile:', error)
    return null
  }
}
