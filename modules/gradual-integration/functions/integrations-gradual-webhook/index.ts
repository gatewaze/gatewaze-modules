import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  createFullRegistration,
  cancelRegistration,
  type RegistrationData,
  type EventData,
} from '../_shared/lumaRegistration.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const customerioSiteId = Deno.env.get('CUSTOMERIO_SITE_ID') || Deno.env.get('VITE_CUSTOMERIO_SITE_ID')
const customerioApiKey = Deno.env.get('CUSTOMERIO_API_KEY') || Deno.env.get('VITE_CUSTOMERIO_API_KEY')

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-gradual-signature',
}

// =============================================================================
// Type Definitions
// =============================================================================

type GradualEventType =
  | 'newUserIsCreated'
  | 'userRegistersForEvent'
  | 'userCancelsEventRegistration'
  | 'userChecksinForEvent'
  | 'userChecksInToEvent'
  | 'userAttendsEvent'
  | 'userUnChecksInToEvent'
  | 'userRefersEventRegistrant'
  | 'userProfileUpdate'
  | 'newEventIsPublished'

interface GradualUserInfo {
  userId?: string
  userEmail?: string
  userFirstName?: string
  userLastName?: string
  userCompany?: string
  userTitle?: string
  userLinkedIn?: string
  userAvatarUrl?: string
  userLocation?: string
  memberType?: string
  approvalStatus?: string
  externalId?: string
  externalDisplayId?: string
  externalProfileUrl?: string
}

interface GradualEventInfo {
  eventName?: string
  eventSlug?: string
  eventslug?: string // fallback for lowercase
  eventUrl?: string
  eventId?: string // Gradual's internal event ID
  ticketType?: string
  attendeeId?: string
}

interface GradualTrackingData {
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  utmTerm?: string
  referUrl?: string
}

interface GradualReferralData {
  referringCode?: string
  referringUserId?: string
  referringUserEmail?: string
  referringUserFirstName?: string
  referringUserLastName?: string
  referringUserTitle?: string
  referringUserCompany?: string
  referringUserLinkedIn?: string
}

interface GradualRegistrantData {
  registeringUserId?: string
  registeringUserFirstName?: string
  registeringUserLastName?: string
  registeringUserTitle?: string
  registeringUserCompany?: string
  registeringUserLinkedIn?: string
}

interface NewUserCreatedPayload extends GradualUserInfo, GradualTrackingData {
  type: 'newUserIsCreated'
  dateOfSignUp: string
  signUpSource?: string
}

interface UserRegistersForEventPayload extends GradualUserInfo, GradualEventInfo, GradualReferralData, GradualTrackingData {
  type: 'userRegistersForEvent'
  dateOfRegistration: string
  eventQuestions?: Record<string, unknown> | string // Can be empty string or object
}

interface UserCancelsEventRegistrationPayload extends GradualUserInfo, GradualEventInfo {
  type: 'userCancelsEventRegistration'
  dateOfCancellation: string
}

interface UserChecksinForEventPayload extends GradualUserInfo, GradualEventInfo {
  type: 'userChecksinForEvent'
  dateOfGuestCheckin: string
}

interface UserChecksInToEventPayload extends GradualUserInfo, GradualEventInfo {
  type: 'userChecksInToEvent'
  dateOfCheckIn: string
}

interface UserAttendsEventPayload extends GradualUserInfo, GradualEventInfo {
  type: 'userAttendsEvent'
  dateOfAttendance: string
}

interface UserUnChecksInToEventPayload extends GradualUserInfo, GradualEventInfo {
  type: 'userUnChecksInToEvent'
  dateOfUnCheckIn: string
}

interface UserRefersEventRegistrantPayload extends GradualEventInfo, GradualReferralData, GradualRegistrantData {
  type: 'userRefersEventRegistrant'
  dateOfReferral: string
}

interface UserProfileUpdatePayload extends GradualUserInfo {
  type: 'userProfileUpdate'
  dateOfProfileUpdate: string
  onboardingQuestions?: Record<string, unknown>
}

interface NewEventIsPublishedPayload {
  type: 'newEventIsPublished'
  dateOfPublication: string
  eventId: string
  eventName: string
  eventSlug: string
  eventUrl: string
  eventCoverImageUrl?: string
  eventType?: string
  // Event timing - Gradual may send these
  eventStartDate?: string
  eventEndDate?: string
  eventDate?: string
  startDate?: string
  endDate?: string
  startTime?: string
  endTime?: string
  timezone?: string
  // Event location
  eventLocation?: string
  location?: string
  isVirtual?: boolean
  isOnline?: boolean
}

type GradualWebhookPayload =
  | NewUserCreatedPayload
  | UserRegistersForEventPayload
  | UserCancelsEventRegistrationPayload
  | UserChecksinForEventPayload
  | UserChecksInToEventPayload
  | UserAttendsEventPayload
  | UserUnChecksInToEventPayload
  | UserRefersEventRegistrantPayload
  | UserProfileUpdatePayload
  | NewEventIsPublishedPayload

// =============================================================================
// Customer.io Integration
// =============================================================================

async function trackEventInCustomerIO(
  email: string,
  eventName: string,
  eventData: Record<string, unknown>
): Promise<void> {
  if (!customerioSiteId || !customerioApiKey) {
    console.log('Customer.io credentials not configured, skipping event tracking')
    return
  }

  try {
    const response = await fetch(
      `https://track.customer.io/api/v1/customers/${encodeURIComponent(email)}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${customerioSiteId}:${customerioApiKey}`)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: eventName,
          data: eventData,
        }),
      }
    )

    if (response.ok) {
      console.log(`Tracked event ${eventName} in Customer.io for ${email}`)
    } else {
      console.error(`Failed to track event in Customer.io: ${response.status}`)
    }
  } catch (error) {
    console.error('Error tracking event in Customer.io:', error)
  }
}

async function updateCustomerInCustomerIO(
  email: string,
  attributes: Record<string, unknown>
): Promise<void> {
  if (!customerioSiteId || !customerioApiKey) {
    console.log('Customer.io credentials not configured, skipping customer update')
    return
  }

  try {
    const response = await fetch(
      `https://track.customer.io/api/v1/customers/${encodeURIComponent(email)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Basic ${btoa(`${customerioSiteId}:${customerioApiKey}`)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(attributes),
      }
    )

    if (response.ok) {
      console.log(`Updated customer ${email} in Customer.io`)
    } else {
      console.error(`Failed to update customer in Customer.io: ${response.status}`)
    }
  } catch (error) {
    console.error('Error updating customer in Customer.io:', error)
  }
}

// =============================================================================
// Webhook Forwarding (Make.com Integration)
// =============================================================================

// User-related webhooks (newUserIsCreated, userProfileUpdate)
const MAKE_USER_WEBHOOK_URL = 'https://hook.eu1.make.com/0ff9h59k21q04fy19ca846xo41v3q6km'
// Event-related webhooks (registrations, check-ins, etc.)
const MAKE_EVENT_WEBHOOK_URL = 'https://hook.eu1.make.com/dm163febs1nl6tabqx539h1r6xqv94p9'

/**
 * Forward the complete webhook payload to Make.com for migration continuity.
 * This is a fire-and-forget operation - we don't wait for the response.
 * Called AFTER processing to ensure Make.com failures don't affect our app.
 */
async function forwardToMakeWebhook(payload: GradualWebhookPayload, webhookUrl: string): Promise<void> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (response.ok) {
      console.log(`Forwarded ${payload.type} to Make.com webhook`)
    } else {
      console.error(`Failed to forward to Make.com: ${response.status} ${response.statusText}`)
    }
  } catch (error) {
    console.error('Error forwarding to Make.com webhook:', error)
  }
}

// =============================================================================
// Database Operations
// =============================================================================

/**
 * Generate a unique 6-character event ID (same pattern as frontend scrapers)
 */
async function generateUniqueEventId(): Promise<string> {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const numbers = '0123456789'

  // Get existing event IDs to avoid collisions
  const { data: existingEvents } = await supabase
    .from('events')
    .select('event_id')
    .limit(10000)

  const existingIds = new Set(existingEvents?.map((e) => e.event_id) || [])

  let id: string
  let attempts = 0
  const maxAttempts = 100

  do {
    id = ''
    // Add 3-4 random letters
    const letterCount = 3 + Math.floor(Math.random() * 2)
    for (let i = 0; i < letterCount; i++) {
      id += letters[Math.floor(Math.random() * letters.length)]
    }
    // Add remaining characters as numbers
    const remainingChars = 6 - letterCount
    for (let i = 0; i < remainingChars; i++) {
      id += numbers[Math.floor(Math.random() * numbers.length)]
    }
    attempts++
  } while (existingIds.has(id) && attempts < maxAttempts)

  return id
}

/**
 * Download image from URL and upload to Supabase Storage
 * Returns the public URL of the uploaded image
 */
async function downloadAndUploadCoverImage(
  imageUrl: string,
  eventId: string
): Promise<string | null> {
  try {
    // Download the image
    const response = await fetch(imageUrl)
    if (!response.ok) {
      console.error(`Failed to download image: ${response.status}`)
      return null
    }

    // Get the content type to determine file extension
    const contentType = response.headers.get('content-type') || 'image/jpeg'
    const extension = contentType.includes('png')
      ? 'png'
      : contentType.includes('gif')
        ? 'gif'
        : contentType.includes('webp')
          ? 'webp'
          : 'jpg'

    // Get the image data as array buffer
    const arrayBuffer = await response.arrayBuffer()
    const uint8Array = new Uint8Array(arrayBuffer)

    // Upload to Supabase Storage
    const fileName = `gradual-events/${eventId}/cover.${extension}`
    const { data, error } = await supabase.storage
      .from('media')
      .upload(fileName, uint8Array, {
        contentType,
        upsert: true,
      })

    if (error) {
      console.error('Failed to upload image to storage:', error)
      return null
    }

    // Get the public URL
    const {
      data: { publicUrl },
    } = supabase.storage.from('media').getPublicUrl(fileName)

    console.log(`Uploaded cover image to: ${publicUrl}`)
    return publicUrl
  } catch (error) {
    console.error('Error downloading/uploading cover image:', error)
    return null
  }
}

/**
 * Look up an event by its Gradual event slug
 */
async function findEventByGradualSlug(
  eventSlug: string
): Promise<{ id: string; event_id: string; event_title: string; event_city?: string; event_country_code?: string; venue_address?: string } | null> {
  const { data, error } = await supabase
    .from('events')
    .select('id, event_id, event_title, event_city, event_country_code, venue_address')
    .eq('gradual_eventslug', eventSlug)
    .maybeSingle()

  if (error) {
    console.error('Error looking up event by gradual_eventslug:', error)
    return null
  }

  return data
}

/**
 * Create or update event attendance record
 */
async function createEventAttendance(
  eventId: string,
  memberProfileId: string,
  checkInTime: string
): Promise<{ id: string } | null> {
  // Check if attendance already exists
  const { data: existing } = await supabase
    .from('events_attendance')
    .select('id')
    .eq('event_id', eventId)
    .eq('people_profile_id', memberProfileId)
    .maybeSingle()

  if (existing) {
    // Update existing attendance with new check-in time
    const { data, error } = await supabase
      .from('events_attendance')
      .update({
        checked_in_at: checkInTime,
        checked_out_at: null, // Clear checkout on new check-in
        check_in_method: 'gradual',
      })
      .eq('id', existing.id)
      .select('id')
      .single()

    if (error) {
      console.error('Error updating event attendance:', error)
      return null
    }
    console.log(`Updated attendance ${data.id} for event ${eventId}`)
    return data
  }

  // Create new attendance record
  const { data, error } = await supabase
    .from('events_attendance')
    .insert({
      event_id: eventId,
      people_profile_id: memberProfileId,
      checked_in_at: checkInTime,
      check_in_method: 'gradual',
    })
    .select('id')
    .single()

  if (error) {
    console.error('Error creating event attendance:', error)
    return null
  }

  console.log(`Created attendance ${data.id} for event ${eventId}`)
  return data
}

/**
 * Remove event attendance (un-check-in)
 */
async function removeEventAttendance(
  eventId: string,
  memberProfileId: string,
  uncheckInTime: string
): Promise<boolean> {
  // Instead of deleting, we set checked_out_at to mark them as no longer attending
  const { error } = await supabase
    .from('events_attendance')
    .update({ checked_out_at: uncheckInTime })
    .eq('event_id', eventId)
    .eq('people_profile_id', memberProfileId)

  if (error) {
    console.error('Error removing event attendance:', error)
    return false
  }

  console.log(`Marked attendance as checked out for event ${eventId}`)
  return true
}

/**
 * Find profile by person email
 */
async function findProfileByEmail(email: string): Promise<string | null> {
  const { data: person } = await supabase
    .from('people')
    .select('id')
    .ilike('email', email)
    .maybeSingle()

  if (!person) {
    return null
  }

  const { data: profile } = await supabase
    .from('people_profiles')
    .select('id')
    .eq('person_id', person.id)
    .maybeSingle()

  return profile?.id || null
}

/**
 * Upsert person in Supabase and create auth user if needed
 * Follows the same pattern as customerio-webhook for consistency
 */
async function upsertPerson(userInfo: GradualUserInfo, trackingData?: GradualTrackingData) {
  if (!userInfo.userEmail) {
    console.log('No email provided, skipping person upsert')
    return null
  }

  const email = userInfo.userEmail.toLowerCase()

  // Build attributes from Gradual user info
  const attributes: Record<string, unknown> = {
    gradual_user_id: userInfo.userId,
    first_name: userInfo.userFirstName,
    last_name: userInfo.userLastName,
    company: userInfo.userCompany,
    job_title: userInfo.userTitle,
    linkedin_url: userInfo.userLinkedIn,
    avatar_url: userInfo.userAvatarUrl,
    location: userInfo.userLocation,
    gradual_member_type: userInfo.memberType,
    gradual_approval_status: userInfo.approvalStatus,
    gradual_external_id: userInfo.externalId,
    gradual_external_display_id: userInfo.externalDisplayId,
    gradual_external_profile_url: userInfo.externalProfileUrl,
  }

  if (trackingData) {
    attributes.utm_source = trackingData.utmSource
    attributes.utm_medium = trackingData.utmMedium
    attributes.utm_campaign = trackingData.utmCampaign
    attributes.utm_content = trackingData.utmContent
    attributes.utm_term = trackingData.utmTerm
    attributes.refer_url = trackingData.referUrl
  }

  // Remove undefined values
  Object.keys(attributes).forEach((key) => {
    if (attributes[key] === undefined) {
      delete attributes[key]
    }
  })

  // Check if person exists by email (case-insensitive)
  const { data: existingPerson, error: lookupError } = await supabase
    .from('people')
    .select('id, cio_id, email, attributes, auth_user_id')
    .ilike('email', email)
    .maybeSingle()

  if (lookupError) {
    console.error('Error looking up person:', lookupError)
  }

  const now = new Date().toISOString()

  if (existingPerson) {
    // Merge new attributes with existing ones (new values take precedence)
    const existingAttrs = existingPerson.attributes as Record<string, any> || {}
    const mergedAttributes = {
      ...existingAttrs,
      ...attributes,
      last_gradual_sync: now,
      // Set marketing_consent to true for Gradual users, but don't overwrite an explicit false
      ...(existingAttrs.marketing_consent !== false ? { marketing_consent: true } : {}),
    }

    // Update existing person
    const { data, error } = await supabase
      .from('people')
      .update({
        attributes: mergedAttributes,
        last_synced_at: now,
      })
      .eq('id', existingPerson.id)
      .select()
      .single()

    if (error) {
      console.error('Error updating person:', error)
      return null
    }

    console.log(`Updated person ${email}`)

    // If person doesn't have auth user, create/link one
    if (!existingPerson.auth_user_id) {
      const authUserId = await ensureAuthUser(email, attributes)
      if (authUserId) {
        await supabase
          .from('people')
          .update({ auth_user_id: authUserId })
          .eq('id', existingPerson.id)
        console.log(`Linked auth user ${authUserId} to person ${existingPerson.id}`)
      }
    }

    return data
  } else {
    // Create new person with auth user
    const authUserId = await ensureAuthUser(email, attributes)

    const { data, error } = await supabase
      .from('people')
      .insert({
        email: email,
        cio_id: `email:${email}`,
        auth_user_id: authUserId,
        attributes: {
          ...attributes,
          source: 'gradual_webhook',
          marketing_consent: true, // Gradual is exclusively MLOps community, consent by default
          last_gradual_sync: now,
        },
        last_synced_at: now,
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating person:', error)
      return null
    }

    console.log(`Created person ${email} with auth_user_id: ${authUserId}`)
    return data
  }
}

/**
 * Ensure an auth user exists for the given email
 * Returns the auth user ID (existing or newly created)
 */
async function ensureAuthUser(
  email: string,
  attributes: Record<string, unknown>
): Promise<string | null> {
  // First check if auth user already exists by email
  const { data: existingUsersData, error: listError } = await supabase.auth.admin.listUsers()

  if (listError) {
    console.error('Error listing users:', listError)
  }

  const existingAuthUser = existingUsersData?.users?.find(
    (u: { email?: string }) => u.email?.toLowerCase() === email.toLowerCase()
  )

  if (existingAuthUser) {
    console.log(`Found existing auth user: ${existingAuthUser.id}`)
    return existingAuthUser.id
  }

  // Create new auth user
  console.log(`Creating auth user for ${email}...`)

  const userMetadata = {
    created_via: 'gradual_webhook',
    first_name: attributes.first_name || '',
    last_name: attributes.last_name || '',
    company: attributes.company || '',
    job_title: attributes.job_title || '',
    linkedin_url: attributes.linkedin_url || '',
    gradual_user_id: attributes.gradual_user_id || '',
  }

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: email,
    email_confirm: true, // Auto-confirm to skip email notification
    user_metadata: userMetadata,
  })

  if (authError) {
    // If user already exists (race condition), try to find them
    if (
      authError.message.includes('already registered') ||
      authError.message.includes('already exists')
    ) {
      console.log(`Auth user ${email} already exists, looking up...`)
      const { data: retryData } = await supabase.auth.admin.listUsers()
      const retryUser = retryData?.users?.find(
        (u: { email?: string }) => u.email?.toLowerCase() === email.toLowerCase()
      )
      if (retryUser) {
        return retryUser.id
      }
    }
    console.error('Error creating auth user:', authError)
    return null
  }

  if (authData?.user?.id) {
    console.log(`Created new auth user: ${authData.user.id}`)
    return authData.user.id
  }

  return null
}

/**
 * Store a pending registration for an event that doesn't exist yet
 * These will be processed when the event is added with the matching gradual_eventslug
 */
async function storePendingRegistration(
  payload: UserRegistersForEventPayload
): Promise<{ id: string } | null> {
  const eventSlug = getEventSlug(payload)
  const parsedQuestions = parseEventQuestions(payload.eventQuestions)

  try {
    const { data, error } = await supabase
      .from('gradual_pending_registrations')
      .upsert(
        {
          gradual_user_id: payload.userId,
          gradual_eventslug: eventSlug,
          user_email: payload.userEmail?.toLowerCase(),
          user_first_name: payload.userFirstName,
          user_last_name: payload.userLastName,
          user_company: payload.userCompany,
          user_title: payload.userTitle,
          user_linkedin: payload.userLinkedIn,
          user_avatar_url: payload.userAvatarUrl,
          user_location: payload.userLocation,
          event_name: payload.eventName,
          event_url: payload.eventUrl,
          registration_date: payload.dateOfRegistration,
          referring_code: payload.referringCode,
          referring_user_id: payload.referringUserId,
          referring_user_email: payload.referringUserEmail,
          event_questions: parsedQuestions,
          utm_source: payload.utmSource,
          utm_medium: payload.utmMedium,
          utm_campaign: payload.utmCampaign,
          utm_content: payload.utmContent,
          utm_term: payload.utmTerm,
          refer_url: payload.referUrl,
          status: 'pending',
          raw_webhook_payload: payload,
        },
        {
          onConflict: 'gradual_eventslug,user_email',
          ignoreDuplicates: false,
        }
      )
      .select('id')
      .single()

    if (error) {
      console.error('Error storing pending registration:', error)
      return null
    }

    console.log(`Stored pending registration ${data.id} for ${payload.userEmail} - event: ${eventSlug}`)
    return data
  } catch (error) {
    console.error('Error in storePendingRegistration:', error)
    return null
  }
}

/**
 * Store a pending attendance for an event that doesn't exist yet
 * These will be processed when the event is added with the matching gradual_eventslug
 */
async function storePendingAttendance(
  payload: UserAttendsEventPayload
): Promise<{ id: string } | null> {
  const eventSlug = getEventSlug(payload)

  try {
    const { data, error } = await supabase
      .from('gradual_pending_attendance')
      .upsert(
        {
          gradual_user_id: payload.userId,
          gradual_eventslug: eventSlug,
          user_email: payload.userEmail?.toLowerCase(),
          user_first_name: payload.userFirstName,
          user_last_name: payload.userLastName,
          user_company: payload.userCompany,
          user_title: payload.userTitle,
          user_linkedin: payload.userLinkedIn,
          user_avatar_url: payload.userAvatarUrl,
          user_location: payload.userLocation,
          event_name: payload.eventName,
          event_url: payload.eventUrl,
          attendance_date: payload.dateOfAttendance,
          status: 'pending',
          raw_webhook_payload: payload,
        },
        {
          onConflict: 'gradual_eventslug,user_email',
          ignoreDuplicates: false,
        }
      )
      .select('id')
      .single()

    if (error) {
      console.error('Error storing pending attendance:', error)
      return null
    }

    console.log(`Stored pending attendance ${data.id} for ${payload.userEmail} - event: ${eventSlug}`)
    return data
  } catch (error) {
    console.error('Error in storePendingAttendance:', error)
    return null
  }
}

async function logGradualEvent(
  eventType: string,
  payload: GradualWebhookPayload,
  userEmail?: string
) {
  try {
    const { error } = await supabase.from('gradual_webhook_events').insert({
      event_type: eventType,
      user_email: userEmail,
      payload: payload,
      received_at: new Date().toISOString(),
    })

    if (error) {
      // Table might not exist, just log the error
      console.log('Could not log to gradual_webhook_events table:', error.message)
    }
  } catch (e) {
    console.log('gradual_webhook_events table not available')
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get event slug from payload - handles both eventSlug and eventslug field names
 */
function getEventSlug(payload: GradualEventInfo): string | undefined {
  return payload.eventSlug || payload.eventslug
}

/**
 * Parse event questions - handles both object and empty string
 */
function parseEventQuestions(eventQuestions: Record<string, unknown> | string | undefined): Record<string, unknown> | undefined {
  if (!eventQuestions || eventQuestions === '') {
    return undefined
  }
  if (typeof eventQuestions === 'string') {
    try {
      return JSON.parse(eventQuestions)
    } catch {
      return undefined
    }
  }
  return eventQuestions
}

// =============================================================================
// Event Handlers
// =============================================================================

async function handleNewUserCreated(payload: NewUserCreatedPayload): Promise<Response> {
  console.log(`Processing newUserIsCreated for ${payload.userEmail}`)

  // Upsert person in our database
  await upsertPerson(payload, payload)

  // Sync to Customer.io
  if (payload.userEmail) {
    await updateCustomerInCustomerIO(payload.userEmail, {
      email: payload.userEmail,
      first_name: payload.userFirstName,
      last_name: payload.userLastName,
      company: payload.userCompany,
      job_title: payload.userTitle,
      linkedin_url: payload.userLinkedIn,
      avatar_url: payload.userAvatarUrl,
      location: payload.userLocation,
      gradual_user_id: payload.userId,
      gradual_member_type: payload.memberType,
      gradual_approval_status: payload.approvalStatus,
      gradual_signup_source: payload.signUpSource,
      gradual_signup_date: payload.dateOfSignUp,
      utm_source: payload.utmSource,
      utm_medium: payload.utmMedium,
      utm_campaign: payload.utmCampaign,
      utm_content: payload.utmContent,
      utm_term: payload.utmTerm,
      marketing_consent: true,
    })

    await trackEventInCustomerIO(payload.userEmail, 'gradual_user_created', {
      signup_source: payload.signUpSource,
      member_type: payload.memberType,
      approval_status: payload.approvalStatus,
    })
  }

  // Forward to Make.com after processing (fire-and-forget)
  forwardToMakeWebhook(payload, MAKE_USER_WEBHOOK_URL)

  return new Response(JSON.stringify({ success: true, action: 'user_created' }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function handleUserRegistersForEvent(payload: UserRegistersForEventPayload): Promise<Response> {
  const eventSlug = getEventSlug(payload)
  console.log(`Processing userRegistersForEvent for ${payload.userEmail} - event: ${eventSlug}`)

  if (!eventSlug) {
    return new Response(JSON.stringify({ error: 'Missing eventSlug in payload' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Look up event by gradual_eventslug
  const event = await findEventByGradualSlug(eventSlug)

  // Loop prevention: if event exists and user is already registered, skip the entire flow.
  // This prevents the loop when Gatewaze syncs a registration TO Gradual and Gradual's
  // webhook fires back trying to create it again in Gatewaze.
  if (event && payload.userEmail) {
    const { data: existingPerson } = await supabase
      .from('people')
      .select('id')
      .ilike('email', payload.userEmail)
      .limit(1)
      .maybeSingle()

    if (existingPerson) {
      const { data: memberProfile } = await supabase
        .from('people_profiles')
        .select('id')
        .eq('person_id', existingPerson.id)
        .limit(1)
        .maybeSingle()

      if (memberProfile) {
        const { data: existingReg } = await supabase
          .from('events_registrations')
          .select('id')
          .eq('event_id', event.event_id)
          .eq('people_profile_id', memberProfile.id)
          .limit(1)
          .maybeSingle()

        if (existingReg) {
          console.log(`Registration already exists for ${payload.userEmail} on event ${event.event_id} (reg: ${existingReg.id}) — skipping (loop prevention)`)

          // Still forward to Make.com for tracking
          forwardToMakeWebhook(payload, MAKE_EVENT_WEBHOOK_URL)

          return new Response(
            JSON.stringify({
              success: true,
              action: 'already_registered',
              registrationId: existingReg.id,
              message: 'Registration already exists — skipped to prevent loop',
            }),
            {
              status: 200,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          )
        }
      }
    }
  }

  if (!event) {
    console.log(`No event found with gradual_eventslug: ${eventSlug}`)
    // Still upsert person so they exist when the event is later added
    await upsertPerson(payload, payload)

    // Store as pending registration - will be processed when event is added
    const pendingReg = await storePendingRegistration(payload)

    if (payload.userEmail) {
      await trackEventInCustomerIO(payload.userEmail, 'gradual_event_registration', {
        event_name: payload.eventName,
        event_slug: eventSlug,
        event_url: payload.eventUrl,
        registration_date: payload.dateOfRegistration,
        referring_code: payload.referringCode,
        referring_user_email: payload.referringUserEmail,
        event_questions: parseEventQuestions(payload.eventQuestions),
        registration_status: 'pending_event_not_found',
        pending_registration_id: pendingReg?.id,
      })
    }

    // Forward to Make.com after processing (fire-and-forget)
    forwardToMakeWebhook(payload, MAKE_EVENT_WEBHOOK_URL)

    return new Response(
      JSON.stringify({
        success: true,
        action: 'pending_registration_stored',
        pending_registration_id: pendingReg?.id,
        message: `Event '${eventSlug}' not found - registration stored for later processing`,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Transform eventQuestions to registrationAnswers format
  // Gradual provides eventQuestions as an object (or empty string), we convert to array format like Luma
  let registrationAnswers: Record<string, any>[] | undefined
  const parsedQuestions = parseEventQuestions(payload.eventQuestions)
  if (parsedQuestions && typeof parsedQuestions === 'object' && Object.keys(parsedQuestions).length > 0) {
    registrationAnswers = Object.entries(parsedQuestions).map(([question, answer]) => ({
      question,
      answer,
      source: 'gradual',
    }))
  }

  // Build registration data
  const registrationData: RegistrationData = {
    email: payload.userEmail || '',
    firstName: payload.userFirstName,
    lastName: payload.userLastName,
    gradualUserId: payload.userId,
    registrationAnswers,
    registeredAt: payload.dateOfRegistration,
    source: 'gradual_webhook',
  }

  // Build event data
  const eventData: EventData = {
    eventId: event.event_id,
    eventCity: event.event_city,
    eventCountryCode: event.event_country_code,
    venueAddress: event.venue_address,
  }

  // Create registration using shared utilities
  // Gradual is exclusively for the MLOps community, so treat as consented
  const result = await createFullRegistration(
    supabase,
    registrationData,
    eventData,
    customerioSiteId,
    customerioApiKey,
    true // Gradual users consent to marketing by default
  )

  if (!result.success) {
    console.error('Failed to create registration:', result.error)
    return new Response(
      JSON.stringify({
        error: 'Failed to create registration',
        details: result.error,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Track event in Customer.io
  if (payload.userEmail) {
    await trackEventInCustomerIO(payload.userEmail, 'gradual_event_registration', {
      event_name: payload.eventName,
      event_slug: eventSlug,
      event_url: payload.eventUrl,
      registration_date: payload.dateOfRegistration,
      referring_code: payload.referringCode,
      referring_user_email: payload.referringUserEmail,
      event_questions: parsedQuestions,
      internal_event_id: event.id,
      registration_id: result.registrationId,
      registration_action: result.action,
    })
  }

  // Forward to Make.com after processing (fire-and-forget)
  forwardToMakeWebhook(payload, MAKE_EVENT_WEBHOOK_URL)

  return new Response(
    JSON.stringify({
      success: true,
      action: 'event_registration',
      registration_id: result.registrationId,
      registration_action: result.action,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  )
}

async function handleUserCancelsEventRegistration(payload: UserCancelsEventRegistrationPayload): Promise<Response> {
  const eventSlug = getEventSlug(payload)
  console.log(`Processing userCancelsEventRegistration for ${payload.userEmail} - event: ${eventSlug}`)

  if (!eventSlug || !payload.userEmail) {
    return new Response(JSON.stringify({ error: 'Missing eventSlug or email in payload' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Look up event by gradual_eventslug
  const event = await findEventByGradualSlug(eventSlug)

  if (!event) {
    console.log(`No event found with gradual_eventslug: ${eventSlug}`)
    // Still track in Customer.io
    await trackEventInCustomerIO(payload.userEmail, 'gradual_event_cancellation', {
      event_name: payload.eventName,
      event_slug: eventSlug,
      event_url: payload.eventUrl,
      cancellation_date: payload.dateOfCancellation,
      cancellation_status: 'event_not_mapped',
    })

    return new Response(
      JSON.stringify({
        success: true,
        action: 'event_cancellation',
        warning: `Event with gradual_eventslug '${eventSlug}' not found in database`,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Cancel registration using shared utilities
  const result = await cancelRegistration(supabase, payload.userEmail, event.event_id)

  if (!result.success) {
    console.error('Failed to cancel registration:', result.error)
    // Still track in Customer.io even if cancellation failed
    await trackEventInCustomerIO(payload.userEmail, 'gradual_event_cancellation', {
      event_name: payload.eventName,
      event_slug: eventSlug,
      event_url: payload.eventUrl,
      cancellation_date: payload.dateOfCancellation,
      cancellation_error: result.error,
    })

    return new Response(
      JSON.stringify({
        success: true,
        action: 'event_cancellation',
        warning: result.error,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Track in Customer.io
  await trackEventInCustomerIO(payload.userEmail, 'gradual_event_cancellation', {
    event_name: payload.eventName,
    event_slug: eventSlug,
    event_url: payload.eventUrl,
    cancellation_date: payload.dateOfCancellation,
    internal_event_id: event.id,
    registration_id: result.registrationId,
    previous_status: result.previousStatus,
  })

  // Forward to Make.com after processing (fire-and-forget)
  forwardToMakeWebhook(payload, MAKE_EVENT_WEBHOOK_URL)

  return new Response(
    JSON.stringify({
      success: true,
      action: 'event_cancellation',
      registration_id: result.registrationId,
      previous_status: result.previousStatus,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  )
}

async function handleUserCheckin(
  payload: UserChecksinForEventPayload | UserChecksInToEventPayload,
  eventName: string
): Promise<Response> {
  const email = payload.userEmail
  const eventSlug = getEventSlug(payload)
  const checkinDate = 'dateOfGuestCheckin' in payload ? payload.dateOfGuestCheckin : payload.dateOfCheckIn

  console.log(`Processing ${payload.type} for ${email} - event: ${eventSlug}`)

  if (!email || !eventSlug) {
    return new Response(JSON.stringify({ error: 'Missing email or eventslug in payload' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Upsert person (ensures user exists)
  await upsertPerson(payload)

  // Look up event by gradual_eventslug
  const event = await findEventByGradualSlug(eventSlug)

  if (!event) {
    console.log(`No event found with gradual_eventslug: ${eventSlug}`)
    await trackEventInCustomerIO(email, eventName, {
      event_name: payload.eventName,
      event_slug: eventSlug,
      event_url: payload.eventUrl,
      checkin_date: checkinDate,
      checkin_status: 'event_not_mapped',
    })

    return new Response(
      JSON.stringify({
        success: true,
        action: 'event_checkin',
        warning: `Event with gradual_eventslug '${eventSlug}' not found in database`,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Find member profile for this user
  const memberProfileId = await findProfileByEmail(email)

  if (!memberProfileId) {
    console.log(`No member profile found for email: ${email}`)
    await trackEventInCustomerIO(email, eventName, {
      event_name: payload.eventName,
      event_slug: eventSlug,
      event_url: payload.eventUrl,
      checkin_date: checkinDate,
      checkin_status: 'member_not_found',
    })

    return new Response(
      JSON.stringify({
        success: true,
        action: 'event_checkin',
        warning: `No member profile found for ${email}`,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Create or update attendance record
  const attendance = await createEventAttendance(event.event_id, memberProfileId, checkinDate)

  await trackEventInCustomerIO(email, eventName, {
    event_name: payload.eventName,
    event_slug: eventSlug,
    event_url: payload.eventUrl,
    checkin_date: checkinDate,
    internal_event_id: event.id,
    attendance_id: attendance?.id,
  })

  // Forward to Make.com after processing (fire-and-forget)
  forwardToMakeWebhook(payload, MAKE_EVENT_WEBHOOK_URL)

  return new Response(
    JSON.stringify({
      success: true,
      action: 'event_checkin',
      attendance_id: attendance?.id,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  )
}

async function handleUserAttendsEvent(payload: UserAttendsEventPayload): Promise<Response> {
  const eventSlug = getEventSlug(payload)
  console.log(`Processing userAttendsEvent for ${payload.userEmail} - event: ${eventSlug}`)

  const email = payload.userEmail

  if (!email || !eventSlug) {
    return new Response(JSON.stringify({ error: 'Missing email or eventslug in payload' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Upsert person (ensures user exists)
  await upsertPerson(payload)

  // Look up event by gradual_eventslug
  const event = await findEventByGradualSlug(eventSlug)

  if (!event) {
    console.log(`No event found with gradual_eventslug: ${eventSlug}`)

    // Store as pending attendance - will be processed when event is added
    const pendingAtt = await storePendingAttendance(payload)

    await trackEventInCustomerIO(email, 'gradual_event_attendance', {
      event_name: payload.eventName,
      event_slug: eventSlug,
      event_url: payload.eventUrl,
      attendance_date: payload.dateOfAttendance,
      attendance_status: 'pending_event_not_found',
      pending_attendance_id: pendingAtt?.id,
    })

    // Forward to Make.com after processing (fire-and-forget)
    forwardToMakeWebhook(payload, MAKE_EVENT_WEBHOOK_URL)

    return new Response(
      JSON.stringify({
        success: true,
        action: 'pending_attendance_stored',
        pending_attendance_id: pendingAtt?.id,
        message: `Event '${eventSlug}' not found - attendance stored for later processing`,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Find member profile for this user
  const memberProfileId = await findProfileByEmail(email)

  if (!memberProfileId) {
    console.log(`No member profile found for email: ${email}`)
    await trackEventInCustomerIO(email, 'gradual_event_attendance', {
      event_name: payload.eventName,
      event_slug: eventSlug,
      event_url: payload.eventUrl,
      attendance_date: payload.dateOfAttendance,
      attendance_status: 'member_not_found',
    })

    return new Response(
      JSON.stringify({
        success: true,
        action: 'event_attendance',
        warning: `No member profile found for ${email}`,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Create or update attendance record
  const attendance = await createEventAttendance(event.event_id, memberProfileId, payload.dateOfAttendance)

  await trackEventInCustomerIO(email, 'gradual_event_attendance', {
    event_name: payload.eventName,
    event_slug: eventSlug,
    event_url: payload.eventUrl,
    attendance_date: payload.dateOfAttendance,
    internal_event_id: event.id,
    attendance_id: attendance?.id,
  })

  // Forward to Make.com after processing (fire-and-forget)
  forwardToMakeWebhook(payload, MAKE_EVENT_WEBHOOK_URL)

  return new Response(
    JSON.stringify({
      success: true,
      action: 'event_attendance',
      attendance_id: attendance?.id,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  )
}

async function handleUserUnChecksIn(payload: UserUnChecksInToEventPayload): Promise<Response> {
  const eventSlug = getEventSlug(payload)
  console.log(`Processing userUnChecksInToEvent for ${payload.userEmail} - event: ${eventSlug}`)

  const email = payload.userEmail

  if (!email || !eventSlug) {
    return new Response(JSON.stringify({ error: 'Missing email or eventslug in payload' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Look up event by gradual_eventslug
  const event = await findEventByGradualSlug(eventSlug)

  if (!event) {
    console.log(`No event found with gradual_eventslug: ${eventSlug}`)
    await trackEventInCustomerIO(email, 'gradual_event_uncheckin', {
      event_name: payload.eventName,
      event_slug: eventSlug,
      event_url: payload.eventUrl,
      uncheckin_date: payload.dateOfUnCheckIn,
      uncheckin_status: 'event_not_mapped',
    })

    return new Response(
      JSON.stringify({
        success: true,
        action: 'event_uncheckin',
        warning: `Event with gradual_eventslug '${eventSlug}' not found in database`,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Find member profile for this user
  const memberProfileId = await findProfileByEmail(email)

  if (!memberProfileId) {
    console.log(`No member profile found for email: ${email}`)
    await trackEventInCustomerIO(email, 'gradual_event_uncheckin', {
      event_name: payload.eventName,
      event_slug: eventSlug,
      event_url: payload.eventUrl,
      uncheckin_date: payload.dateOfUnCheckIn,
      uncheckin_status: 'member_not_found',
    })

    return new Response(
      JSON.stringify({
        success: true,
        action: 'event_uncheckin',
        warning: `No member profile found for ${email}`,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Remove attendance (set checked_out_at)
  const success = await removeEventAttendance(event.event_id, memberProfileId, payload.dateOfUnCheckIn)

  await trackEventInCustomerIO(email, 'gradual_event_uncheckin', {
    event_name: payload.eventName,
    event_slug: eventSlug,
    event_url: payload.eventUrl,
    uncheckin_date: payload.dateOfUnCheckIn,
    internal_event_id: event.id,
    uncheckin_success: success,
  })

  // Forward to Make.com after processing (fire-and-forget)
  forwardToMakeWebhook(payload, MAKE_EVENT_WEBHOOK_URL)

  return new Response(
    JSON.stringify({
      success: true,
      action: 'event_uncheckin',
      attendance_removed: success,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  )
}

async function handleUserRefersEventRegistrant(payload: UserRefersEventRegistrantPayload): Promise<Response> {
  const eventSlug = getEventSlug(payload)
  console.log(`Processing userRefersEventRegistrant - referrer: ${payload.referringUserEmail}`)

  // Track for the referring user
  if (payload.referringUserEmail) {
    await trackEventInCustomerIO(payload.referringUserEmail, 'gradual_referral_success', {
      event_name: payload.eventName,
      event_slug: eventSlug,
      event_url: payload.eventUrl,
      referral_date: payload.dateOfReferral,
      registering_user_id: payload.registeringUserId,
      registering_user_name: `${payload.registeringUserFirstName} ${payload.registeringUserLastName}`.trim(),
      registering_user_company: payload.registeringUserCompany,
    })
  }

  // Forward to Make.com after processing (fire-and-forget)
  forwardToMakeWebhook(payload, MAKE_EVENT_WEBHOOK_URL)

  return new Response(JSON.stringify({ success: true, action: 'referral_success' }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function handleUserProfileUpdate(payload: UserProfileUpdatePayload): Promise<Response> {
  console.log(`Processing userProfileUpdate for ${payload.userEmail}`)

  await upsertPerson(payload)

  if (payload.userEmail) {
    await updateCustomerInCustomerIO(payload.userEmail, {
      first_name: payload.userFirstName,
      last_name: payload.userLastName,
      company: payload.userCompany,
      job_title: payload.userTitle,
      linkedin_url: payload.userLinkedIn,
      avatar_url: payload.userAvatarUrl,
      location: payload.userLocation,
      gradual_profile_updated_at: payload.dateOfProfileUpdate,
    })

    await trackEventInCustomerIO(payload.userEmail, 'gradual_profile_updated', {
      update_date: payload.dateOfProfileUpdate,
    })
  }

  // Forward to Make.com after processing (fire-and-forget)
  forwardToMakeWebhook(payload, MAKE_USER_WEBHOOK_URL)

  return new Response(JSON.stringify({ success: true, action: 'profile_updated' }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function handleNewEventIsPublished(payload: NewEventIsPublishedPayload): Promise<Response> {
  console.log(`Processing newEventIsPublished for event: ${payload.eventSlug} (${payload.eventName})`)

  if (!payload.eventSlug || !payload.eventName) {
    return new Response(JSON.stringify({ error: 'Missing eventSlug or eventName in payload' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Check if event with this gradual_eventslug already exists
  const existingEvent = await findEventByGradualSlug(payload.eventSlug)
  if (existingEvent) {
    console.log(`Event with gradual_eventslug '${payload.eventSlug}' already exists: ${existingEvent.id}`)
    return new Response(
      JSON.stringify({
        success: true,
        action: 'event_already_exists',
        event_id: existingEvent.id,
        event_title: existingEvent.event_title,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Generate unique event_id
  const shortEventId = await generateUniqueEventId()
  console.log(`Generated event_id: ${shortEventId}`)

  // Download and upload cover image if provided
  let screenshotUrl: string | null = null
  if (payload.eventCoverImageUrl) {
    screenshotUrl = await downloadAndUploadCoverImage(payload.eventCoverImageUrl, shortEventId)
  }

  // Extract event date from payload (Gradual may send in various formats)
  const eventStartDate = payload.eventStartDate || payload.startDate || payload.eventDate || null
  const eventEndDate = payload.eventEndDate || payload.endDate || null

  // Gradual events are virtual/online by default
  const isOnline = payload.isVirtual || payload.isOnline || true
  const eventLocation = payload.eventLocation || payload.location || (isOnline ? 'Online' : null)

  // Create the event
  const { data: newEvent, error } = await supabase
    .from('events')
    .insert({
      event_id: shortEventId,
      event_title: payload.eventName,
      event_link: payload.eventUrl,
      event_type: payload.eventType || 'Conference',
      gradual_eventslug: payload.eventSlug,
      source_type: 'gradual',
      // Date fields
      event_date: eventStartDate,
      event_start_date: eventStartDate,
      event_end_date: eventEndDate,
      timezone: payload.timezone,
      // Location - default to Online for Gradual virtual events
      event_city: isOnline ? 'Online' : null,
      event_country_code: isOnline ? 'Online' : null,
      event_location: eventLocation,
      is_virtual: isOnline,
      source_details: {
        gradual_event_id: payload.eventId,
        gradual_event_slug: payload.eventSlug,
        gradual_event_url: payload.eventUrl,
        gradual_cover_image: payload.eventCoverImageUrl,
        imported_at: new Date().toISOString(),
      },
      screenshot_url: screenshotUrl,
      screenshot_generated: screenshotUrl ? true : false,
      screenshot_generated_at: screenshotUrl ? new Date().toISOString() : null,
      status: 'incomplete', // Default status - needs more info
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('id, event_id, event_title')
    .single()

  if (error) {
    console.error('Failed to create event:', error)
    return new Response(
      JSON.stringify({
        error: 'Failed to create event',
        details: error.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  console.log(`Created new event: ${newEvent.id} (${newEvent.event_id}) - ${newEvent.event_title}`)

  // Forward to Make.com after processing (fire-and-forget)
  forwardToMakeWebhook(payload, MAKE_EVENT_WEBHOOK_URL)

  return new Response(
    JSON.stringify({
      success: true,
      action: 'event_created',
      event_uuid: newEvent.id,
      event_id: newEvent.event_id,
      event_title: newEvent.event_title,
      screenshot_url: screenshotUrl,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  )
}

// =============================================================================
// Main Handler
// =============================================================================

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Only POST method is allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  let payload: GradualWebhookPayload
  try {
    payload = await req.json()
    if (!payload || !payload.type) {
      return new Response(JSON.stringify({ error: 'Invalid payload: missing type field' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
  } catch (error) {
    return new Response(JSON.stringify({ error: `Failed to parse JSON: ${error.message}` }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  console.log(`Received Gradual webhook: ${payload.type}`)

  // Log the event (fire-and-forget)
  const userEmail = 'userEmail' in payload ? payload.userEmail : undefined
  logGradualEvent(payload.type, payload, userEmail)

  // Route to appropriate handler
  try {
    switch (payload.type) {
      case 'newUserIsCreated':
        return handleNewUserCreated(payload as NewUserCreatedPayload)

      case 'userRegistersForEvent':
        return handleUserRegistersForEvent(payload as UserRegistersForEventPayload)

      case 'userCancelsEventRegistration':
        return handleUserCancelsEventRegistration(payload as UserCancelsEventRegistrationPayload)

      case 'userChecksinForEvent':
        return handleUserCheckin(payload as UserChecksinForEventPayload, 'gradual_guest_checkin')

      case 'userChecksInToEvent':
        return handleUserCheckin(payload as UserChecksInToEventPayload, 'gradual_event_checkin')

      case 'userAttendsEvent':
        return handleUserAttendsEvent(payload as UserAttendsEventPayload)

      case 'userUnChecksInToEvent':
        return handleUserUnChecksIn(payload as UserUnChecksInToEventPayload)

      case 'userRefersEventRegistrant':
        return handleUserRefersEventRegistrant(payload as UserRefersEventRegistrantPayload)

      case 'userProfileUpdate':
        return handleUserProfileUpdate(payload as UserProfileUpdatePayload)

      case 'newEventIsPublished':
        return handleNewEventIsPublished(payload as NewEventIsPublishedPayload)

      default:
        console.log(`Unknown event type: ${payload.type}`)
        return new Response(
          JSON.stringify({
            success: true,
            action: 'unknown_event_logged',
            event_type: payload.type,
          }),
          {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        )
    }
  } catch (error) {
    console.error(`Error handling ${payload.type}:`, error)
    return new Response(
      JSON.stringify({
        error: `Failed to process ${payload.type}`,
        message: error.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }
})
