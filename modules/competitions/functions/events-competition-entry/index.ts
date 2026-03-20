import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { isCIOConfigured, upsertCIOCustomer, trackCIOEvent } from '../_shared/customerio.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
// IP geolocation now uses ip-api.com (no API key required)

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform',
}

interface CompetitionEntryRequest {
  email: string
  competition_id: string
  source?: string
  metadata?: Record<string, any>
}

interface CompetitionEntryResponse {
  success: boolean
  message: string
  entry_id?: string
  member_profile_id?: string
  person_id?: number
  already_entered?: boolean
  error?: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  try {
    const body: CompetitionEntryRequest = await req.json()
    const { email, competition_id, source, metadata = {} } = body

    if (!email) {
      return new Response(JSON.stringify({ success: false, error: 'Email is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!competition_id) {
      return new Response(JSON.stringify({ success: false, error: 'Competition ID is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid email format' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const normalizedEmail = email.toLowerCase().trim()
    console.log(`🏆 Processing competition entry for: ${normalizedEmail}, competition: ${competition_id}`)

    // Step 1: Verify competition exists and is active
    const { data: competition, error: compError } = await supabase
      .from('events_competitions')
      .select('id, event_id, title, status, close_date')
      .eq('id', competition_id)
      .single()

    if (compError || !competition) {
      return new Response(JSON.stringify({ success: false, error: 'Competition not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (competition.status !== 'active') {
      return new Response(JSON.stringify({ success: false, error: 'Competition is not active' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (competition.close_date) {
      const closeDate = new Date(competition.close_date)
      if (closeDate < new Date()) {
        return new Response(JSON.stringify({ success: false, error: 'Competition has closed' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    }

    console.log(`✅ Competition verified: ${competition.title} (event: ${competition.event_id})`)

    // Step 2: Get IP-based location
    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
                     req.headers.get('x-real-ip') ||
                     null
    const ipLocation = await getIpLocation(clientIp)
    if (ipLocation?.city) {
      console.log(`📍 IP location detected: ${ipLocation.city}, ${ipLocation.country}`)
    }

    // Step 3: Find or create person
    const person = await findOrCreatePerson(normalizedEmail, ipLocation)
    if (!person) {
      return new Response(JSON.stringify({ success: false, error: 'Failed to create or find person' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`✅ Person ready: id=${person.id}`)

    // Step 4: Get or create member profile
    const memberProfile = await getOrCreateMemberProfile(person.id)
    if (!memberProfile) {
      return new Response(JSON.stringify({ success: false, error: 'Failed to create member profile' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`✅ Member profile ready: id=${memberProfile.id}`)

    // Step 5: Check for existing entry
    const { data: existingEntry } = await supabase
      .from('events_competition_entries')
      .select('id')
      .eq('competition_id', competition_id)
      .eq('email', normalizedEmail)
      .maybeSingle()

    if (existingEntry) {
      console.log(`⚠️ Already entered: ${existingEntry.id}`)
      return new Response(JSON.stringify({
        success: true,
        message: 'Already entered this competition',
        entry_id: existingEntry.id,
        member_profile_id: memberProfile.id,
        person_id: person.id,
        already_entered: true
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Step 6: Create entry
    const { data: entry, error: entryError } = await supabase
      .from('events_competition_entries')
      .insert({
        competition_id,
        email: normalizedEmail,
        member_profile_id: memberProfile.id,
        status: 'entered',
        entered_at: new Date().toISOString(),
        referrer: source || null,
        entry_metadata: metadata,
      })
      .select('id')
      .single()

    if (entryError) {
      console.error('Error creating entry:', entryError)
      return new Response(JSON.stringify({
        success: false,
        error: `Failed to create entry: ${entryError.message}`
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`✅ Entry created: ${entry.id}`)

    // Step 7: Send competition entry confirmation email (non-blocking)
    sendCompetitionEntryEmail({
      eventId: competition.event_id,
      competitionTitle: competition.title,
      email: normalizedEmail,
      personId: person.id,
    }).catch(err => console.error('Failed to send competition entry email:', err))

    // Step 8: Track in CIO (non-blocking)
    if (isCIOConfigured) {
      trackCIOEvent(normalizedEmail, 'competition_entered', {
        competition_id,
        competition_title: competition.title,
        event_id: competition.event_id,
        source: source || 'event_portal',
      }).catch(err => console.error('Failed to track CIO event:', err))
    }

    // Conversion tracking is handled by DB trigger on competition_entries INSERT

    return new Response(JSON.stringify({
      success: true,
      message: 'Successfully entered competition',
      entry_id: entry.id,
      member_profile_id: memberProfile.id,
      person_id: person.id,
      already_entered: false
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('❌ Competition entry error:', error)
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
 * Get IP-based location from ip-api.com (free, no API key required)
 * Matches implementation from normalize-person-location edge function
 *
 * Returns:
 * - city: City name (e.g., "San Francisco")
 * - country: Full country name (e.g., "United States")
 * - country_code: 2-letter uppercase code (e.g., "US")
 * - continent: 2-letter lowercase code (e.g., "na", "eu", "as")
 * - location: "latitude,longitude" string
 */
async function getIpLocation(ipAddress: string | null): Promise<{
  city?: string;
  country?: string;
  country_code?: string;
  continent?: string;
  location?: string;
} | null> {
  if (!ipAddress) return null

  try {
    const url = `http://ip-api.com/json/${encodeURIComponent(ipAddress)}?fields=status,message,city,country,countryCode,continentCode,lat,lon`
    const response = await fetch(url)

    if (!response.ok) {
      console.error(`IP geolocation API error: ${response.status}`)
      return null
    }

    const data = await response.json()

    if (data.status === 'fail') {
      console.error(`IP geolocation failed: ${data.message}`)
      return null
    }

    return {
      city: data.city || undefined,
      country: data.country || undefined, // Full name: "United States"
      country_code: data.countryCode || undefined, // 2-letter code: "US"
      continent: data.continentCode ? data.continentCode.toLowerCase() : undefined, // Lowercase: "na", "eu", "as"
      location: data.lat && data.lon ? `${data.lat},${data.lon}` : undefined, // "lat,lng"
    }
  } catch (error) {
    console.error('Error fetching IP location:', error)
    return null
  }
}

async function findOrCreatePerson(
  email: string,
  ipLocation?: { city?: string; country?: string; country_code?: string; continent?: string; location?: string } | null
): Promise<{ id: number; cio_id: string } | null> {
  try {
    const { data: existingPerson } = await supabase
      .from('people')
      .select('id, cio_id, attributes')
      .ilike('email', email)
      .maybeSingle()

    if (existingPerson) {
      // Update location from IP if missing
      const existingAttrs = existingPerson.attributes as Record<string, any> || {}
      const needsCity = !existingAttrs.city && ipLocation?.city
      const needsCountry = !existingAttrs.country && ipLocation?.country
      const needsCountryCode = !existingAttrs.country_code && ipLocation?.country_code
      const needsContinent = !existingAttrs.continent && ipLocation?.continent
      const needsLocation = !existingAttrs.location && ipLocation?.location

      if (needsCity || needsCountry || needsCountryCode || needsContinent || needsLocation) {
        const updatedAttrs = { ...existingAttrs }
        if (needsCity) updatedAttrs.city = ipLocation?.city
        if (needsCountry) updatedAttrs.country = ipLocation?.country
        if (needsCountryCode) updatedAttrs.country_code = ipLocation?.country_code
        if (needsContinent) updatedAttrs.continent = ipLocation?.continent
        if (needsLocation) updatedAttrs.location = ipLocation?.location

        await supabase
          .from('people')
          .update({ attributes: updatedAttrs })
          .eq('id', existingPerson.id)

        console.log(`Updated existing person ${existingPerson.id} with IP location`)
      }

      return existingPerson
    }

    // Prepare Customer.io attributes with IP location
    const cioAttributes: Record<string, any> = {
      email,
      source: 'competition_entry',
      signup_source: 'competition_entry',
      created_at: Math.floor(Date.now() / 1000),
    }
    if (ipLocation?.city) cioAttributes.city = ipLocation.city
    if (ipLocation?.country) cioAttributes.country = ipLocation.country
    if (ipLocation?.country_code) cioAttributes.country_code = ipLocation.country_code
    if (ipLocation?.continent) cioAttributes.continent = ipLocation.continent
    if (ipLocation?.location) cioAttributes.location = ipLocation.location

    // Create in CIO (fire-and-forget)
    if (isCIOConfigured) {
      upsertCIOCustomer(email, cioAttributes).catch(err => console.error('CIO error:', err))
    }

    const temporaryCioId = `email:${email.toLowerCase()}`

    // Create auth user
    let authUserId: string | null = null
    try {
      const { data: newAuthUser, error: createError } = await supabase.auth.admin.createUser({
        email,
        email_confirm: false,
      })

      if (createError) {
        if (createError.message?.includes('already been registered')) {
          const { data: existingAuthUserId } = await supabase
            .rpc('get_auth_user_id_by_email', { p_email: email })
          if (existingAuthUserId) authUserId = existingAuthUserId
        }
      } else if (newAuthUser.user) {
        authUserId = newAuthUser.user.id
      }
    } catch (error) {
      console.error('Error creating auth user:', error)
    }

    // Prepare person attributes with IP location
    const personAttributes: Record<string, any> = {}
    if (ipLocation?.city) personAttributes.city = ipLocation.city
    if (ipLocation?.country) personAttributes.country = ipLocation.country
    if (ipLocation?.country_code) personAttributes.country_code = ipLocation.country_code
    if (ipLocation?.continent) personAttributes.continent = ipLocation.continent
    if (ipLocation?.location) personAttributes.location = ipLocation.location

    // Create person record
    const { data: newPerson, error: insertError } = await supabase
      .from('people')
      .insert({
        cio_id: temporaryCioId,
        email,
        auth_user_id: authUserId,
        attributes: personAttributes,
        last_synced_at: new Date().toISOString()
      })
      .select('id, cio_id')
      .single()

    if (insertError) {
      const { data: retryPerson } = await supabase
        .from('people')
        .select('id, cio_id')
        .ilike('email', email)
        .maybeSingle()
      return retryPerson
    }

    return newPerson
  } catch (error) {
    console.error('Error in findOrCreatePerson:', error)
    return null
  }
}

async function getOrCreateMemberProfile(personId: number): Promise<{ id: string } | null> {
  try {
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

// --- Competition Entry Auto-Responder Email ---

const FROM_ADDRESSES: Record<string, string> = {
  events: Deno.env.get('SENDGRID_FROM_EVENTS') || 'events@techtickets.dev',
  partners: Deno.env.get('SENDGRID_FROM_PARTNERS') || 'partners@techtickets.dev',
  members: Deno.env.get('SENDGRID_FROM_MEMBERS') || 'members@techtickets.dev',
  admin: Deno.env.get('SENDGRID_FROM_ADMIN') || 'admin@techtickets.dev',
  default: Deno.env.get('SENDGRID_FROM_DEFAULT') || 'hello@techtickets.dev',
}

interface SendCompetitionEntryEmailParams {
  eventId: string
  competitionTitle: string
  email: string
  personId: number
}

async function sendCompetitionEntryEmail(params: SendCompetitionEntryEmailParams): Promise<void> {
  const { eventId, competitionTitle, email, personId } = params

  try {
    const { data: settings, error: settingsError } = await supabase
      .from('events_communication_settings')
      .select('competition_entry_email_enabled, competition_entry_email_template_id, competition_entry_email_from_key, competition_entry_email_reply_to, competition_entry_email_cc, competition_entry_email_subject, competition_entry_email_content')
      .eq('event_id', eventId)
      .maybeSingle()

    if (settingsError) {
      console.error('Error fetching communication settings:', settingsError)
      return
    }

    if (!settings || !settings.competition_entry_email_enabled) {
      console.log('Competition entry email not enabled for event:', eventId)
      return
    }

    let emailSubject: string | null = null
    let emailContent: string | null = null

    if (settings.competition_entry_email_template_id) {
      const { data: template } = await supabase
        .from('email_templates')
        .select('subject, content_html')
        .eq('id', settings.competition_entry_email_template_id)
        .eq('is_active', true)
        .maybeSingle()

      if (template) {
        emailSubject = template.subject
        emailContent = template.content_html
      }
    }

    if (!emailSubject || !emailContent) {
      emailSubject = settings.competition_entry_email_subject || null
      emailContent = settings.competition_entry_email_content || null
    }

    if (!emailSubject || !emailContent) {
      console.log('No competition entry email content configured for event:', eventId)
      return
    }

    // Get event details for template variables
    const { data: eventDetails } = await supabase
      .from('events')
      .select('event_title, event_city, event_country_code, event_start, event_end, event_location, event_link')
      .eq('event_id', eventId)
      .maybeSingle()

    // Get person attributes for template variables
    const { data: person } = await supabase
      .from('people')
      .select('attributes')
      .eq('id', personId)
      .maybeSingle()

    const attrs = (person?.attributes as Record<string, any>) || {}

    const context: Record<string, Record<string, string>> = {
      customer: {
        first_name: attrs.first_name || '',
        last_name: attrs.last_name || '',
        full_name: [attrs.first_name, attrs.last_name].filter(Boolean).join(' ') || '',
        email: email,
      },
      event: {
        name: eventDetails?.event_title || '',
        title: eventDetails?.event_title || '',
        city: eventDetails?.event_city || '',
        country: eventDetails?.event_country_code || '',
        location: eventDetails?.event_location || '',
        link: eventDetails?.event_link || '',
        start_date: eventDetails?.event_start ? new Date(eventDetails.event_start).toLocaleDateString('en-US', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        }) : '',
        end_date: eventDetails?.event_end ? new Date(eventDetails.event_end).toLocaleDateString('en-US', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        }) : '',
      },
      competition: {
        title: competitionTitle,
      },
    }

    const replaceVariables = (text: string): string => {
      return text.replace(/\{\{([^}]+)\}\}/g, (match, content) => {
        const defaultMatch = content.match(/^(.+?)\s*\|\s*default:\s*"([^"]*)"/)
        const path = defaultMatch ? defaultMatch[1].trim() : content.trim()
        const defaultValue = defaultMatch ? defaultMatch[2] : ''
        const parts = path.split('.')
        let value: any = context
        for (const part of parts) {
          if (value && typeof value === 'object' && part in value) {
            value = value[part]
          } else {
            value = null
            break
          }
        }
        if (typeof value === 'string' && value.length > 0) return value
        return defaultValue || match
      })
    }

    const processedSubject = replaceVariables(emailSubject)
    const processedHtml = replaceVariables(emailContent)

    const fromKey = settings.competition_entry_email_from_key || 'events'
    const fromAddress = FROM_ADDRESSES[fromKey] || FROM_ADDRESSES.events

    console.log(`Sending competition entry email to ${email} for event ${eventId}`)

    const sendEmailResponse = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: email,
        from: fromAddress,
        subject: processedSubject,
        html: processedHtml,
        replyTo: settings.competition_entry_email_reply_to || undefined,
        cc: settings.competition_entry_email_cc || undefined,
        personId: personId,
      }),
    })

    if (!sendEmailResponse.ok) {
      const errorText = await sendEmailResponse.text()
      console.error('Failed to send competition entry email:', errorText)
      return
    }

    console.log(`Competition entry confirmation email sent to ${email}`)

    if (settings.competition_entry_email_template_id) {
      supabase.rpc('increment_email_template_usage', {
        template_id: settings.competition_entry_email_template_id,
      }).catch(() => {})
    }
  } catch (error) {
    console.error('Error sending competition entry email:', error)
  }
}
