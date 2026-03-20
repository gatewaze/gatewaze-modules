import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface SpeakerSubmission {
  id: string  // speaker_id
  talk_id: string
  status: string  // from event_talks
  talk_title: string  // from event_talks
  talk_synopsis: string  // from event_talks
  speaker_bio: string | null  // from event_speakers
  speaker_title: string | null  // from event_speakers
  edit_token: string  // from event_talks (for editing the talk)
  presentation_url: string | null
  presentation_storage_path: string | null
  presentation_type: string | null
  calendar_added_at: string | null
  created_at: string
  updated_at: string
  event: {
    id: string
    event_id: string
    event_slug: string | null
    event_title: string
    event_start: string
    event_end: string | null
    event_timezone: string | null
    event_city: string | null
    event_region: string | null
    event_country_code: string | null
    gradient_color_1: string | null
    gradient_color_2: string | null
    event_logo: string | null
    screenshot_url: string | null
    enable_call_for_speakers: boolean
  }
}

interface SpeakerSubmissionsResponse {
  success: boolean
  submissions?: SpeakerSubmission[]
  error?: string
}

interface UpdatePresentationRequest {
  edit_token: string
  presentation_url?: string | null
  presentation_storage_path?: string | null
  presentation_type?: 'link' | 'pdf' | 'powerpoint' | null
  calendar_added_at?: string | null  // ISO timestamp when calendar was added
  tracking_link_copied_at?: string | null  // ISO timestamp when tracking link was copied
}

interface UpdatePresentationResponse {
  success: boolean
  error?: string
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Route to appropriate handler
  if (req.method === 'GET') {
    return handleGet(req)
  } else if (req.method === 'PUT') {
    return handlePut(req)
  } else {
    return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})

/**
 * Handle GET requests - fetch all submissions for the authenticated user
 */
async function handleGet(req: Request): Promise<Response> {
  try {
    // Authenticate the request
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ success: false, error: 'Authorization required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const token = authHeader.split(' ')[1]
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      console.error('Auth error:', authError)
      return new Response(JSON.stringify({ success: false, error: 'Invalid or expired token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`📋 Fetching submissions for user: ${user.id}`)

    // Find the person record for this auth user
    const { data: person, error: personError } = await supabase
      .from('people')
      .select('id, email')
      .eq('auth_user_id', user.id)
      .maybeSingle()

    if (personError) {
      console.error('Person lookup error:', personError)
      return new Response(JSON.stringify({ success: false, error: 'Failed to look up user' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!person) {
      // User exists in auth but no person record - return empty array
      console.log('No person record found for user')
      return new Response(JSON.stringify({ success: true, submissions: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Get all profiles for this person
    const { data: profiles, error: profileError } = await supabase
      .from('people_profiles')
      .select('id')
      .eq('person_id', person.id)

    if (profileError) {
      console.error('Profile lookup error:', profileError)
      return new Response(JSON.stringify({ success: false, error: 'Failed to look up profiles' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!profiles || profiles.length === 0) {
      // No profiles - return empty array
      console.log('No profiles found')
      return new Response(JSON.stringify({ success: true, submissions: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const profileIds = profiles.map(p => p.id)

    // Fetch all speaker submissions for these profiles
    // Join through event_talk_speakers to get talk data from event_talks
    // Talk data (title, synopsis, status, edit_token, presentation fields) is now in event_talks
    // Speaker profile data (speaker_bio, speaker_title) is in event_speakers
    const { data: speakers, error: speakersError } = await supabase
      .from('events_speakers')
      .select(`
        id,
        speaker_bio,
        speaker_title,
        created_at,
        updated_at,
        events!event_speakers_event_uuid_fkey (
          id,
          event_id,
          event_slug,
          event_title,
          event_start,
          event_end,
          event_timezone,
          event_city,
          event_region,
          event_country_code,
          gradient_color_1,
          gradient_color_2,
          event_logo,
          screenshot_url,
          enable_call_for_speakers
        ),
        event_talk_speakers!inner (
          is_primary,
          talk:event_talks (
            id,
            title,
            synopsis,
            status,
            edit_token,
            presentation_url,
            presentation_storage_path,
            presentation_type,
            calendar_added_at,
            tracking_link_copied_at,
            submitted_at
          )
        )
      `)
      .in('people_profile_id', profileIds)
      .eq('event_talk_speakers.is_primary', true)
      .order('created_at', { ascending: false })

    if (speakersError) {
      console.error('Speakers lookup error:', speakersError)
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to look up submissions',
        details: speakersError.message,
        code: speakersError.code
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Transform the data to flatten the relationships
    // Talk data comes from event_talks via event_talk_speakers
    // Each speaker may have multiple talks - we need to return one submission per talk
    const submissions: SpeakerSubmission[] = (speakers || []).flatMap(speaker => {
      const talkSpeakers = (speaker.event_talk_speakers as any[]) || []

      return talkSpeakers.map(talkSpeaker => {
        const talk = talkSpeaker?.talk

        return {
          id: speaker.id,
          talk_id: talk?.id || '',
          status: talk?.status || 'pending',
          talk_title: talk?.title || '',
          talk_synopsis: talk?.synopsis || '',
          speaker_bio: speaker.speaker_bio,
          speaker_title: speaker.speaker_title,
          edit_token: talk?.edit_token || '',  // Use talk's edit token
          presentation_url: talk?.presentation_url || null,
          presentation_storage_path: talk?.presentation_storage_path || null,
          presentation_type: talk?.presentation_type || null,
          calendar_added_at: talk?.calendar_added_at || null,
          created_at: talk?.submitted_at || speaker.created_at,
          updated_at: speaker.updated_at,
          event: speaker.events as unknown as SpeakerSubmission['event'],
        }
      })
    })

    console.log(`✅ Found ${submissions.length} submissions for user`)

    const response: SpeakerSubmissionsResponse = {
      success: true,
      submissions,
    }

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('❌ Speaker submissions GET error:', error)
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
}

/**
 * Handle PUT requests - update presentation info for a talk
 * Uses edit_token for authentication (no user auth required)
 */
async function handlePut(req: Request): Promise<Response> {
  try {
    const body: UpdatePresentationRequest = await req.json()

    // Validate required field
    if (!body.edit_token) {
      return new Response(JSON.stringify({ success: false, error: 'edit_token is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`📝 Updating presentation for talk with edit_token: ${body.edit_token.substring(0, 8)}...`)

    // Find the talk by edit_token
    const { data: talk, error: lookupError } = await supabase
      .from('events_talks')
      .select('id, status')
      .eq('edit_token', body.edit_token)
      .maybeSingle()

    if (lookupError) {
      console.error('Talk lookup error:', lookupError)
      return new Response(JSON.stringify({ success: false, error: 'Failed to look up talk' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!talk) {
      return new Response(JSON.stringify({ success: false, error: 'Talk not found or invalid token' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Build update object with only provided fields
    const updateData: Record<string, any> = {}

    if (body.presentation_url !== undefined) {
      updateData.presentation_url = body.presentation_url
    }
    if (body.presentation_storage_path !== undefined) {
      updateData.presentation_storage_path = body.presentation_storage_path
    }
    if (body.presentation_type !== undefined) {
      updateData.presentation_type = body.presentation_type
    }
    if (body.calendar_added_at !== undefined) {
      updateData.calendar_added_at = body.calendar_added_at
    }
    if (body.tracking_link_copied_at !== undefined) {
      updateData.tracking_link_copied_at = body.tracking_link_copied_at
    }

    // If no fields to update, return success
    if (Object.keys(updateData).length === 0) {
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Update the talk
    const { error: updateError } = await supabase
      .from('events_talks')
      .update(updateData)
      .eq('id', talk.id)

    if (updateError) {
      console.error('Talk update error:', updateError)
      return new Response(JSON.stringify({ success: false, error: 'Failed to update talk' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`✅ Successfully updated presentation for talk ${talk.id}`)

    const response: UpdatePresentationResponse = {
      success: true,
    }

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('❌ Speaker submissions PUT error:', error)
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
}
