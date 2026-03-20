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
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface SpeakerUpdateRequest {
  // Authentication - one of these is required
  edit_token?: string           // For unauthenticated editing (works with both talk and speaker tokens)
  // Or Authorization header with Bearer token for authenticated users

  // Identification - one of these is required
  speaker_id?: string           // Legacy: speaker ID
  talk_id?: string              // New: talk ID (preferred for new submissions)

  // Talk content fields (updates event_talks table)
  talk_title?: string
  talk_synopsis?: string
  talk_duration_minutes?: number

  // Speaker profile fields (updates event_speakers table)
  speaker_bio?: string
  speaker_title?: string

  // Profile fields (updates person record)
  first_name?: string
  last_name?: string
  company?: string
  job_title?: string
  linkedin_url?: string
  avatar_url?: string
}

interface SpeakerUpdateResponse {
  success: boolean
  message: string
  speaker_id?: string
  talk_id?: string
  status?: string
  status_changed?: boolean
  error?: string
  debug?: {
    person_id?: number
    avatar_url_received?: string
    person_update_payload?: Record<string, any>
    person_update_result?: any
    person_update_error?: string
  }
}

export default async function(req: Request) {
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
    const body: SpeakerUpdateRequest = await req.json()
    const { speaker_id, talk_id, edit_token } = body

    if (!speaker_id && !talk_id && !edit_token) {
      return new Response(JSON.stringify({ success: false, error: 'Either speaker_id, talk_id, or edit_token is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`📝 Processing update - speaker_id: ${speaker_id}, talk_id: ${talk_id}, has_edit_token: ${!!edit_token}`)

    // Step 1: Authenticate the request
    let isAuthenticated = false
    let authUserId: string | null = null

    // Check for JWT token in Authorization header
    const authHeader = req.headers.get('Authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1]
      const { data: { user }, error: authError } = await supabase.auth.getUser(token)
      if (!authError && user) {
        authUserId = user.id
        isAuthenticated = true
        console.log('✅ Authenticated via JWT:', authUserId)
      }
    }

    // Step 2: Find talk and speaker records
    let talk: any = null
    let speaker: any = null

    // Try to find by talk_id first
    if (talk_id) {
      const { data: talkData, error: talkError } = await supabase
        .from('events_talks')
        .select('id, status, title, synopsis, duration_minutes, edit_token')
        .eq('id', talk_id)
        .single()

      if (talkError || !talkData) {
        console.error('Error fetching talk by ID:', talkError)
        return new Response(JSON.stringify({ success: false, error: 'Talk not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      talk = talkData
    }

    // Try to find by edit_token (can be talk or speaker token)
    if (edit_token && !talk) {
      // First try talk's edit_token
      const { data: talkByToken } = await supabase
        .from('events_talks')
        .select('id, status, title, synopsis, duration_minutes, edit_token')
        .eq('edit_token', edit_token)
        .maybeSingle()

      if (talkByToken) {
        talk = talkByToken
        console.log('✅ Found talk by edit_token')
      }
    }

    // Get the primary speaker for this talk
    if (talk) {
      const { data: talkSpeaker } = await supabase
        .from('events_talk_speakers')
        .select(`
          speaker_id,
          speaker:event_speakers!speaker_id (
            id,
            status,
            speaker_bio,
            speaker_title,
            edit_token,
            people_profile_id,
            people_profiles!inner (
              id,
              person_id,
              people!inner (
                id,
                auth_user_id,
                email,
                attributes
              )
            )
          )
        `)
        .eq('talk_id', talk.id)
        .eq('is_primary', true)
        .maybeSingle()

      if (talkSpeaker?.speaker) {
        speaker = talkSpeaker.speaker
      }
    }

    // Fallback: Try speaker_id or speaker's edit_token (legacy support)
    if (!speaker) {
      let speakerQuery = supabase
        .from('events_speakers')
        .select(`
          id,
          status,
          talk_title,
          talk_synopsis,
          speaker_bio,
          speaker_title,
          edit_token,
          people_profile_id,
          people_profiles!inner (
            id,
            person_id,
            people!inner (
              id,
              auth_user_id,
              email,
              attributes
            )
          )
        `)

      if (speaker_id) {
        speakerQuery = speakerQuery.eq('id', speaker_id)
      } else if (edit_token) {
        speakerQuery = speakerQuery.eq('edit_token', edit_token)
      }

      const { data: speakerData, error: speakerError } = await speakerQuery.single()

      if (speakerError || !speakerData) {
        console.error('Error fetching speaker:', speakerError)
        return new Response(JSON.stringify({ success: false, error: 'Speaker not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      speaker = speakerData

      // If no talk found yet, try to find speaker's primary talk
      if (!talk) {
        const { data: speakerTalk } = await supabase
          .from('events_talk_speakers')
          .select('talk:event_talks(*)')
          .eq('speaker_id', speaker.id)
          .eq('is_primary', true)
          .maybeSingle()

        if (speakerTalk?.talk) {
          talk = speakerTalk.talk
        }
      }
    }

    console.log(`✅ Found speaker: ${speaker?.id}, talk: ${talk?.id}`)

    // Step 3: Verify authorization
    let authorized = false

    // Check talk's edit token
    if (edit_token && talk?.edit_token === edit_token) {
      authorized = true
      console.log('✅ Authorized via talk edit token')
    }

    // Check speaker's edit token (legacy)
    if (edit_token && speaker?.edit_token === edit_token) {
      authorized = true
      console.log('✅ Authorized via speaker edit token')
    }

    // Check if authenticated user owns this submission
    if (isAuthenticated && authUserId) {
      const customerAuthUserId = (speaker?.people_profiles as any)?.people?.auth_user_id
      if (customerAuthUserId === authUserId) {
        authorized = true
        console.log('✅ Authorized via auth user ID match')
      }
    }

    if (!authorized) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Step 4: Check if submission can be edited based on status
    // Status is now only on event_talks table
    const currentStatus = talk?.status
    const nonEditableStatuses = ['rejected']
    if (currentStatus && nonEditableStatuses.includes(currentStatus)) {
      return new Response(JSON.stringify({
        success: false,
        error: `Cannot edit a ${currentStatus} submission`
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Step 5: Build update objects
    const talkUpdate: Record<string, any> = {}
    const speakerUpdate: Record<string, any> = {}
    let statusChanged = false
    let newStatus = talk?.status

    // Check for talk content changes that require status reset
    const statusResetStatuses = ['approved', 'confirmed']
    const currentTitle = talk?.title
    const currentSynopsis = talk?.synopsis
    const talkTitleChanged = body.talk_title !== undefined && body.talk_title !== currentTitle
    const talkSynopsisChanged = body.talk_synopsis !== undefined && body.talk_synopsis !== currentSynopsis

    if ((talkTitleChanged || talkSynopsisChanged) && statusResetStatuses.includes(newStatus)) {
      newStatus = 'pending'
      statusChanged = true
      console.log(`⚠️ Status reset to pending due to talk content change`)
    }

    // Build talk update (for event_talks table)
    if (body.talk_title !== undefined) talkUpdate.title = body.talk_title
    if (body.talk_synopsis !== undefined) talkUpdate.synopsis = body.talk_synopsis
    if (body.talk_duration_minutes !== undefined) talkUpdate.duration_minutes = body.talk_duration_minutes
    if (statusChanged) talkUpdate.status = newStatus

    // Build speaker update (for event_speakers table - profile fields only)
    // Talk data is now stored exclusively in event_talks table
    if (body.speaker_bio !== undefined) speakerUpdate.speaker_bio = body.speaker_bio
    if (body.speaker_title !== undefined) speakerUpdate.speaker_title = body.speaker_title

    // Step 6a: Update talk record if there are changes and talk exists
    if (talk && Object.keys(talkUpdate).length > 0) {
      talkUpdate.updated_at = new Date().toISOString()

      const { error: talkUpdateError } = await supabase
        .from('events_talks')
        .update(talkUpdate)
        .eq('id', talk.id)

      if (talkUpdateError) {
        console.error('Error updating talk:', talkUpdateError)
        return new Response(JSON.stringify({
          success: false,
          error: `Failed to update talk: ${talkUpdateError.message}`
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      console.log('✅ Talk record updated')
    }

    // Step 6b: Update speaker record if there are changes
    if (speaker && Object.keys(speakerUpdate).length > 0) {
      speakerUpdate.updated_at = new Date().toISOString()

      const { error: updateError } = await supabase
        .from('events_speakers')
        .update(speakerUpdate)
        .eq('id', speaker.id)

      if (updateError) {
        console.error('Error updating speaker:', updateError)
        return new Response(JSON.stringify({
          success: false,
          error: `Failed to update speaker: ${updateError.message}`
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      console.log('✅ Speaker record updated')
    }

    // Step 7: Update profile fields (person attributes and avatar)
    const profileUpdate: Record<string, any> = {}
    if (body.first_name !== undefined) profileUpdate.first_name = body.first_name
    if (body.last_name !== undefined) profileUpdate.last_name = body.last_name
    if (body.company !== undefined) profileUpdate.company = body.company
    if (body.job_title !== undefined) profileUpdate.job_title = body.job_title
    if (body.linkedin_url !== undefined) profileUpdate.linkedin_url = body.linkedin_url

    const hasProfileUpdate = Object.keys(profileUpdate).length > 0
    const hasAvatarUpdate = body.avatar_url !== undefined

    // Debug info to include in response
    let debugInfo: SpeakerUpdateResponse['debug'] = undefined

    if (hasProfileUpdate || hasAvatarUpdate) {
      const personId = (speaker.people_profiles as any)?.people?.id
      const existingAttrs = (speaker.people_profiles as any)?.people?.attributes || {}

      const personUpdate: Record<string, any> = {}

      // Update attributes if there are profile field changes
      if (hasProfileUpdate) {
        personUpdate.attributes = { ...existingAttrs, ...profileUpdate }
      }

      // Update avatar if provided
      if (hasAvatarUpdate && body.avatar_url) {
        console.log('📸 Processing avatar update, URL:', body.avatar_url)
        // Extract storage path from public URL
        // URL format: https://xxx.supabase.co/storage/v1/object/public/customer-avatars/speaker-submissions/xxx.jpg
        const urlParts = body.avatar_url.split('/customer-avatars/')
        console.log('📸 URL parts:', urlParts)
        if (urlParts.length === 2) {
          personUpdate.avatar_storage_path = urlParts[1]
          personUpdate.avatar_source = 'uploaded'
          personUpdate.avatar_updated_at = new Date().toISOString()
          console.log('📸 Avatar storage path set to:', urlParts[1])
        } else {
          console.log('⚠️ Could not extract storage path from URL')
        }
      } else {
        console.log('📸 No avatar update - hasAvatarUpdate:', hasAvatarUpdate, 'avatar_url:', body.avatar_url)
      }

      console.log('📝 Person update payload:', JSON.stringify(personUpdate))
      console.log('📝 Person ID:', personId)

      const { data: personUpdateResult, error: personError } = await supabase
        .from('people')
        .update(personUpdate)
        .eq('id', personId)
        .select('id, avatar_storage_path, avatar_source, avatar_updated_at')

      // Capture debug info
      debugInfo = {
        person_id: personId,
        avatar_url_received: body.avatar_url,
        person_update_payload: personUpdate,
        person_update_result: personUpdateResult,
        person_update_error: personError?.message
      }

      if (personError) {
        console.error('Error updating person:', personError)
        // Don't fail the whole request, just log the error
      } else {
        console.log('✅ Person profile updated successfully:', JSON.stringify(personUpdateResult))
      }
    }

    const response: SpeakerUpdateResponse = {
      success: true,
      message: statusChanged
        ? 'Submission updated. Status reset to pending for re-review.'
        : 'Submission updated successfully.',
      speaker_id: speaker?.id,
      talk_id: talk?.id,
      status: newStatus,
      status_changed: statusChanged,
      debug: debugInfo
    }

    // Debug: Include person update info in response
    console.log('📤 Response:', JSON.stringify(response))

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('❌ Speaker update error:', error)
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
}
