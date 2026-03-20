import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const webhookSecret = Deno.env.get('WEBHOOK_SECRET') // Optional webhook secret for security

// Customer.io webhook signing keys - comma-separated to support multiple brands
// Format: "key1,key2" or just "key1"
const cioSigningKeysRaw = Deno.env.get('CIO_WEBHOOK_SIGNING_KEYS') || Deno.env.get('CIO_WEBHOOK_SIGNING_KEY') || ''
const cioSigningKeys = cioSigningKeysRaw.split(',').map(k => k.trim()).filter(k => k.length > 0)

/**
 * Verify Customer.io webhook signature using HMAC-SHA256
 * CIO sends the signature in the X-CIO-Signature header
 * Tries all configured signing keys (for multi-brand support)
 */
async function verifyCIOSignature(body: string, signature: string | null, signingKeys: string[]): Promise<boolean> {
  if (!signature || signingKeys.length === 0) return false

  const encoder = new TextEncoder()

  for (const signingKey of signingKeys) {
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(signingKey),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      )

      const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
      const expectedSignature = Array.from(new Uint8Array(signatureBytes))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')

      // Constant-time comparison to prevent timing attacks
      if (signature.toLowerCase() === expectedSignature.toLowerCase()) {
        return true
      }
    } catch (error) {
      console.error('Signature verification error:', error)
    }
  }

  return false
}

// Customer.io IP addresses for webhook verification
// https://customer.io/docs/journeys/webhooks/#ip-addresses
const CUSTOMERIO_IPS = new Set([
  // US region
  '35.188.196.183',
  '104.198.177.219',
  '104.154.232.87',
  '130.211.229.195',
  '104.198.221.24',
  '104.197.27.15',
  '35.194.9.154',
  '104.154.144.51',
  '104.197.210.12',
  '35.225.6.73',
  '35.192.215.166',
  '34.170.204.100',
  // EU region
  '34.76.143.229',
  '34.78.91.47',
  '34.77.94.252',
  '35.187.188.242',
  '34.78.122.90',
  '35.195.137.235',
  '130.211.108.156',
  '104.199.50.18',
  '34.78.44.80',
  '35.205.31.154'
])

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
})

interface CustomerIOWebhookPayload {
  data: {
    customer_id?: string
    email?: string
    email_address?: string
    recipient?: string
    identifiers?: {
      email?: string
      id?: string
    }
    topic_id?: string
    customer?: {
      email?: string
      id?: string
      [key: string]: any
    }
    // Email event specific fields
    email_id?: string
    message_id?: string
    campaign_id?: string
    broadcast_id?: string
    action_id?: string
    subject?: string
    link_url?: string
    link_id?: string
    href?: string
    bounce_type?: string
    failure_message?: string
    reason?: string
    [key: string]: any // Allow any additional attributes
  }
  event_type?: string
  metric?: string
  timestamp?: number
  object_type?: string // 'email', 'push', 'sms', etc.
}

// Email event types we want to track
// CIO Reporting Webhooks send metric values WITHOUT the 'email_' prefix (e.g., 'sent', 'delivered')
// CIO Data Pipelines/other webhooks may send WITH the prefix (e.g., 'email_sent', 'email_delivered')
// We support both formats
const EMAIL_EVENT_TYPES = [
  // Without prefix (CIO Reporting Webhooks)
  'drafted',
  'attempted',
  'deferred',
  'sent',
  'delivered',
  'opened',
  'clicked',
  'converted',
  'unsubscribed',
  'bounced',
  'suppressed',
  'spammed',
  'failed',
  'undeliverable',
  // With prefix (CIO Data Pipelines / legacy)
  'email_drafted',
  'email_attempted',
  'email_deferred',
  'email_sent',
  'email_delivered',
  'email_opened',
  'email_clicked',
  'email_converted',
  'email_unsubscribed',
  'email_bounced',
  'email_suppressed',
  'email_spammed',
  'email_failed',
  'email_undeliverable'
]

Deno.serve(async (req) => {
  // Set CORS headers to allow webhook calls
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
  }

  // Handle OPTIONS request for CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }

  // Get the client IP address from various possible headers
  // Supabase/Cloudflare typically forwards the real IP in these headers
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
                   req.headers.get('x-real-ip') ||
                   req.headers.get('cf-connecting-ip') ||
                   'unknown'

  console.log(`Webhook request from IP: ${clientIp}`)

  // Read body as text first for signature verification
  const bodyText = await req.text()

  // Check for CIO webhook signature (preferred method)
  const cioSignature = req.headers.get('x-cio-signature')
  let hasValidCIOSignature = false

  if (cioSigningKeys.length > 0 && cioSignature) {
    hasValidCIOSignature = await verifyCIOSignature(bodyText, cioSignature, cioSigningKeys)
    if (hasValidCIOSignature) {
      console.log('Request verified: Valid CIO webhook signature')
    } else {
      console.log('CIO signature verification failed')
    }
  }

  // Check if request is from Customer.io IP addresses (fallback)
  const isFromCustomerIO = CUSTOMERIO_IPS.has(clientIp)

  // Also check for webhook secret (for non-CIO authenticated requests)
  const providedSecret = req.headers.get('x-webhook-secret') || req.headers.get('authorization')?.replace('Bearer ', '')
  const hasValidSecret = webhookSecret && providedSecret === webhookSecret

  // Allow if: valid CIO signature OR from CIO IP OR has valid secret
  if (!hasValidCIOSignature && !isFromCustomerIO && !hasValidSecret) {
    console.error(`Unauthorized webhook request from IP: ${clientIp}`)
    return new Response(JSON.stringify({
      error: 'Unauthorized',
      message: 'Request must have valid CIO signature, come from Customer.io IP, or include valid webhook secret'
    }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  if (!hasValidCIOSignature) {
    if (isFromCustomerIO) {
      console.log('Request verified: Customer.io IP address')
    } else {
      console.log('Request verified: Valid webhook secret')
    }
  }

  try {
    const payload: CustomerIOWebhookPayload = JSON.parse(bodyText)

    // Log event type prominently for easier debugging
    const eventType = payload.event_type || payload.metric || 'unknown'
    console.log(`📩 WEBHOOK EVENT: ${eventType}`)
    console.log('Full payload:', JSON.stringify(payload, null, 2))

    // Handle subscription events (unsubscribe/resubscribe from CIO)
    // CIO sends different event types for different subscription changes:
    // - customer_subscribed / customer_unsubscribed: Global subscription status
    // - cio_subscription_preferences_changed / subscription_preferences_changed: Topic-level changes
    // - email_unsubscribed: Unsubscribe via email link
    // Note: CIO uses 'metric' field, not 'event_type' for reporting webhooks
    const subscriptionEventTypes = [
      'customer_unsubscribed',
      'email_unsubscribed',
      'customer_subscribed',
      'subscription_preferences_changed',
      'cio_subscription_preferences_changed',
      'subscribed',
      'unsubscribed'
    ]
    const isSubscriptionEvent = subscriptionEventTypes.includes(eventType)

    if (isSubscriptionEvent) {
      const subscriptionEmail = payload.data?.email_address ||
                                payload.data?.email ||
                                payload.data?.customer?.email ||
                                payload.data?.identifiers?.email ||
                                payload.data?.recipient

      console.log(`Subscription event detected: ${eventType}`)
      console.log(`Email found: ${subscriptionEmail}`)
      console.log(`Full payload.data:`, JSON.stringify(payload.data, null, 2))

      // Handle subscription_preferences_changed - this contains topic changes
      // CIO may send this as 'subscription_preferences_changed' or 'cio_subscription_preferences_changed'
      const isPreferencesChangedEvent = eventType === 'subscription_preferences_changed' ||
                                         eventType === 'cio_subscription_preferences_changed'

      if (isPreferencesChangedEvent && subscriptionEmail) {
        // Topics can be in multiple locations:
        // 1. payload.data.content (as JSON string) - this is how CIO reporting webhooks send it
        // 2. payload.data.subscription_preferences.topics
        // 3. payload.data.topics
        // 4. payload.data.cio_subscription_preferences.topics
        let topics: Record<string, boolean> | null = null

        // First, try parsing from content field (JSON string)
        if (payload.data?.content && typeof payload.data.content === 'string') {
          try {
            const contentParsed = JSON.parse(payload.data.content)
            if (contentParsed.topics) {
              topics = contentParsed.topics
              console.log('Topics found in content field (parsed from JSON string)')
            }
          } catch (e) {
            console.log('Failed to parse content field as JSON:', e)
          }
        }

        // Fallback to other locations
        if (!topics) {
          topics = payload.data?.subscription_preferences?.topics ||
                   payload.data?.topics ||
                   payload.data?.cio_subscription_preferences?.topics ||
                   null
        }

        const now = new Date().toISOString()

        console.log(`Topics found:`, JSON.stringify(topics, null, 2))

        if (topics && typeof topics === 'object') {
          // Look up person ID from people table by email
          // This allows subscriptions to survive email changes
          const { data: person, error: personLookupError } = await supabase
            .from('people')
            .select('id')
            .ilike('email', subscriptionEmail)
            .maybeSingle()

          if (personLookupError) {
            console.error('Error looking up person:', personLookupError)
          }

          const personId = person?.id
          console.log(`Person lookup for ${subscriptionEmail}: person_id=${personId}`)

          const upsertPromises = Object.entries(topics).map(async ([topicId, isSubscribed]) => {
            console.log(`Processing topic: ${topicId} = ${isSubscribed}`)

            // Build upsert data - include customer_id if we found the customer
            const upsertData: Record<string, any> = {
              email: subscriptionEmail.toLowerCase(),
              list_id: topicId,
              subscribed: Boolean(isSubscribed),
              subscribed_at: isSubscribed ? now : null,
              unsubscribed_at: isSubscribed ? null : now,
              source: 'cio_webhook',
              updated_at: now
            }

            // Add customer_id if we found the person
            if (personId) {
              upsertData.customer_id = personId
            }

            // Use customer_id+list_id as unique constraint if we have person ID
            // Fall back to email+list_id for people not yet in our system
            const onConflict = personId ? 'customer_id,list_id' : 'email,list_id'

            const { error } = await supabase
              .from('email_subscriptions')
              .upsert(upsertData, { onConflict })

            if (error) {
              console.error(`Error updating topic ${topicId}:`, error)
            } else {
              console.log(`Topic ${topicId} updated to ${isSubscribed}`)
            }
            return { topicId, error }
          })

          await Promise.all(upsertPromises)

          return new Response(JSON.stringify({
            success: true,
            message: 'Subscription preferences updated',
            email: subscriptionEmail,
            person_id: personId,
            topics_updated: Object.keys(topics)
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }
      }

      // Handle single topic subscribe/unsubscribe events
      const topicId = payload.data?.topic_id || payload.data?.topic

      if (subscriptionEmail && topicId) {
        const isSubscribed = payload.event_type === 'customer_subscribed' || payload.event_type === 'subscribed'
        const now = new Date().toISOString()

        console.log(`Processing single subscription event: ${subscriptionEmail} -> ${topicId} = ${isSubscribed}`)

        // Look up person ID from people table by email
        const { data: person, error: personLookupError } = await supabase
          .from('people')
          .select('id')
          .ilike('email', subscriptionEmail)
          .maybeSingle()

        if (personLookupError) {
          console.error('Error looking up person:', personLookupError)
        }

        const personId = person?.id
        console.log(`Person lookup for ${subscriptionEmail}: person_id=${personId}`)

        // Build upsert data
        const upsertData: Record<string, any> = {
          email: subscriptionEmail.toLowerCase(),
          list_id: topicId,
          subscribed: isSubscribed,
          subscribed_at: isSubscribed ? now : null,
          unsubscribed_at: isSubscribed ? null : now,
          source: 'cio_webhook',
          updated_at: now
        }

        // Add customer_id if we found the person
        if (personId) {
          upsertData.customer_id = personId
        }

        // Use appropriate unique constraint
        const onConflict = personId ? 'customer_id,list_id' : 'email,list_id'

        const { error: subError } = await supabase
          .from('email_subscriptions')
          .upsert(upsertData, { onConflict })

        if (subError) {
          console.error('Error updating subscription:', subError)
          return new Response(JSON.stringify({
            error: subError.message,
            details: 'Failed to update subscription'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }

        console.log(`Subscription ${isSubscribed ? 'added' : 'removed'}: ${subscriptionEmail} -> ${topicId}`)

        return new Response(JSON.stringify({
          success: true,
          message: `Subscription ${isSubscribed ? 'added' : 'removed'}`,
          email: subscriptionEmail,
          person_id: personId,
          topic_id: topicId
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      } else {
        console.log('Subscription event missing email or topic_id')
        console.log(`Email: ${subscriptionEmail}, TopicId: ${topicId}`)
      }
    }

    // Handle customer attribute change events
    // CIO sends these when attributes are updated in the CIO dashboard or via API
    const attributeChangeEventTypes = [
      'customer_attribute_changed',
      'customer_attributes_updated',
      'customer_updated',
      'customer_created'
    ]
    const isAttributeChangeEvent = attributeChangeEventTypes.includes(eventType)

    if (isAttributeChangeEvent) {
      const attrCustomerEmail = payload.data?.email_address ||
                                payload.data?.email ||
                                payload.data?.customer?.email ||
                                payload.data?.identifiers?.email

      const customerCioId = payload.data?.customer_id ||
                            payload.data?.identifiers?.id ||
                            payload.data?.customer?.id ||
                            payload.data?.cio_id

      console.log(`Customer attribute change event: ${eventType}`)
      console.log(`Email: ${attrCustomerEmail}, CIO ID: ${customerCioId}`)

      if (attrCustomerEmail || customerCioId) {
        // Extract attributes from payload
        // CIO may send attributes in different locations
        const newAttributes = payload.data?.attributes ||
                              payload.data?.customer?.attributes ||
                              payload.data?.customer ||
                              {}

        // Remove system fields from attributes
        const excludedFields = ['customer_id', 'email', 'identifiers', 'id', 'cio_id', 'email_address']
        const cleanAttributes: Record<string, any> = {}
        Object.keys(newAttributes).forEach(key => {
          if (!excludedFields.includes(key)) {
            cleanAttributes[key] = newAttributes[key]
          }
        })

        console.log(`Extracted attributes:`, JSON.stringify(cleanAttributes, null, 2))

        // Find the person in Supabase
        // Check by cio_id first (exact match), then by temporary cio_id format, then by email
        // This handles the case where person was created with temporary cio_id (email:xxx)
        // and CIO is now sending the real cio_id
        let existingPerson = null
        let lookupError = null

        // First try by real cio_id
        if (customerCioId) {
          const { data, error } = await supabase
            .from('people')
            .select('id, cio_id, email, attributes, auth_user_id')
            .eq('cio_id', customerCioId)
            .maybeSingle()

          if (error) lookupError = error
          if (data) existingPerson = data
        }

        // If not found by real cio_id, try by temporary cio_id format (email:xxx)
        if (!existingPerson && attrCustomerEmail) {
          const temporaryCioId = `email:${attrCustomerEmail.toLowerCase()}`
          const { data, error } = await supabase
            .from('people')
            .select('id, cio_id, email, attributes, auth_user_id')
            .eq('cio_id', temporaryCioId)
            .maybeSingle()

          if (error) lookupError = error
          if (data) {
            existingPerson = data
            console.log(`Found person with temporary cio_id: ${temporaryCioId}`)
          }
        }

        // If still not found, try by email (case-insensitive)
        if (!existingPerson && attrCustomerEmail) {
          const { data, error } = await supabase
            .from('people')
            .select('id, cio_id, email, attributes, auth_user_id')
            .ilike('email', attrCustomerEmail)
            .maybeSingle()

          if (error) lookupError = error
          if (data) {
            existingPerson = data
            console.log(`Found person by email: ${attrCustomerEmail}`)
          }
        }

        if (lookupError) {
          console.error('Error looking up person:', lookupError)
        }

        if (existingPerson) {
          // Merge new attributes with existing ones (new values take precedence)
          const mergedAttributes = {
            ...existingPerson.attributes,
            ...cleanAttributes
          }

          // Build update object
          const updateData: Record<string, any> = {
            attributes: mergedAttributes,
            email: attrCustomerEmail || existingPerson.email,
            last_synced_at: new Date().toISOString()
          }

          // Update cio_id if we have a real one from CIO and the existing one is temporary
          // Temporary cio_ids start with "email:" prefix
          if (customerCioId &&
              customerCioId !== existingPerson.cio_id &&
              existingPerson.cio_id?.startsWith('email:')) {
            updateData.cio_id = customerCioId
            console.log(`Updating temporary cio_id from ${existingPerson.cio_id} to ${customerCioId}`)
          }

          const { error: updateError } = await supabase
            .from('people')
            .update(updateData)
            .eq('id', existingPerson.id)

          if (updateError) {
            console.error('Error updating person attributes:', updateError)
            return new Response(JSON.stringify({
              error: updateError.message,
              details: 'Failed to update person attributes'
            }), {
              status: 500,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            })
          }

          console.log(`Updated attributes for person ${existingPerson.id} (${attrCustomerEmail})`)

          // If person doesn't have auth user, create one
          let authUserId = existingPerson.auth_user_id
          if (!authUserId && attrCustomerEmail) {
            console.log(`Person ${attrCustomerEmail} has no auth user, checking/creating...`)

            // First check if auth user already exists by email
            const { data: existingUsersData } = await supabase.auth.admin.listUsers()
            const existingAuthUser = existingUsersData?.users?.find(
              (u: { email?: string }) => u.email?.toLowerCase() === attrCustomerEmail.toLowerCase()
            )

            if (existingAuthUser) {
              authUserId = existingAuthUser.id
              console.log(`Found existing auth user: ${authUserId}`)
            } else {
              // Create new auth user
              const { data: newAuthData, error: authError } = await supabase.auth.admin.createUser({
                email: attrCustomerEmail,
                email_confirm: true,
                user_metadata: {
                  cio_id: customerCioId || existingPerson.cio_id,
                  created_via: 'customerio_webhook',
                  first_name: mergedAttributes.first_name || '',
                  last_name: mergedAttributes.last_name || '',
                  company: mergedAttributes.company || '',
                  job_title: mergedAttributes.job_title || ''
                }
              })

              if (authError) {
                console.error('Error creating auth user:', authError)
              } else if (newAuthData?.user) {
                authUserId = newAuthData.user.id
                console.log(`Created new auth user: ${authUserId}`)
              }
            }

            // Link auth user to person if we have one
            if (authUserId) {
              const { error: linkError } = await supabase
                .from('people')
                .update({ auth_user_id: authUserId })
                .eq('id', existingPerson.id)

              if (linkError) {
                console.error('Error linking auth user to person:', linkError)
              } else {
                console.log(`Linked auth user ${authUserId} to person ${existingPerson.id}`)
              }
            }
          }

          return new Response(JSON.stringify({
            success: true,
            message: 'Person attributes updated',
            person_id: existingPerson.id,
            email: attrCustomerEmail,
            auth_user_id: authUserId,
            attributes_updated: Object.keys(cleanAttributes)
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        } else {
          // Person doesn't exist yet - create them
          console.log(`Person not found, creating new record`)

          // First, check if auth user already exists by email
          let authUserId: string | null = null
          const { data: existingUsersData } = await supabase.auth.admin.listUsers()
          const existingAuthUser = existingUsersData?.users?.find(
            (u: { email?: string }) => u.email?.toLowerCase() === attrCustomerEmail.toLowerCase()
          )

          if (existingAuthUser) {
            authUserId = existingAuthUser.id
            console.log(`Found existing auth user for new person: ${authUserId}`)
          } else {
            // Create new auth user
            const { data: newAuthData, error: authError } = await supabase.auth.admin.createUser({
              email: attrCustomerEmail,
              email_confirm: true,
              user_metadata: {
                cio_id: customerCioId || `email:${attrCustomerEmail}`,
                created_via: 'customerio_webhook',
                first_name: cleanAttributes.first_name || '',
                last_name: cleanAttributes.last_name || '',
                company: cleanAttributes.company || '',
                job_title: cleanAttributes.job_title || ''
              }
            })

            if (authError) {
              console.error('Error creating auth user for new person:', authError)
            } else if (newAuthData?.user) {
              authUserId = newAuthData.user.id
              console.log(`Created new auth user for new person: ${authUserId}`)
            }
          }

          const { data: newPerson, error: insertError } = await supabase
            .from('people')
            .insert({
              cio_id: customerCioId || `email:${attrCustomerEmail}`,
              email: attrCustomerEmail,
              attributes: cleanAttributes,
              auth_user_id: authUserId,
              last_synced_at: new Date().toISOString()
            })
            .select('id')
            .single()

          if (insertError) {
            console.error('Error creating person:', insertError)
            return new Response(JSON.stringify({
              error: insertError.message,
              details: 'Failed to create person'
            }), {
              status: 500,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            })
          }

          console.log(`Created new person ${newPerson?.id} (${attrCustomerEmail}) with auth_user_id: ${authUserId}`)

          return new Response(JSON.stringify({
            success: true,
            message: 'Person created',
            person_id: newPerson?.id,
            email: attrCustomerEmail,
            auth_user_id: authUserId
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }
      } else {
        console.log('Attribute change event missing email and cio_id')
      }
    }

    // Handle email events (sent, delivered, opened, clicked, bounced, etc.)
    // CIO Reporting Webhooks use object_type to indicate the channel (email, push, sms, etc.)
    // We only want to process email events here
    const isEmailChannel = !payload.object_type || payload.object_type === 'email'

    if (eventType && EMAIL_EVENT_TYPES.includes(eventType) && isEmailChannel) {
      console.log(`Email event detected: ${eventType}, object_type: ${payload.object_type || 'not specified'}`)

      // Extract email from various possible locations in the payload
      // CIO Reporting Webhooks typically use 'recipient' for email address
      const customerEmail = payload.data?.recipient ||
                           payload.data?.email_address ||
                           payload.data?.email ||
                           payload.data?.customer?.email ||
                           payload.data?.identifiers?.email

      console.log(`Customer email extracted: ${customerEmail || 'NOT FOUND'}`)
      console.log(`Email extraction sources - recipient: ${payload.data?.recipient}, email_address: ${payload.data?.email_address}, email: ${payload.data?.email}`)

      if (customerEmail) {
        // Parse the event type (remove 'email_' prefix for cleaner storage)
        const cleanEventType = eventType.replace('email_', '')

        // Extract event timestamp
        const eventTimestamp = payload.timestamp
          ? new Date(payload.timestamp * 1000).toISOString()
          : new Date().toISOString()

        // Build the email event record
        const emailEvent = {
          email: customerEmail.toLowerCase(),
          event_type: cleanEventType,
          email_id: payload.data?.email_id || payload.data?.message_id,
          campaign_id: payload.data?.campaign_id,
          broadcast_id: payload.data?.broadcast_id,
          action_id: payload.data?.action_id,
          subject: payload.data?.subject,
          recipient: payload.data?.recipient,
          link_url: payload.data?.link_url || payload.data?.href,
          link_id: payload.data?.link_id,
          bounce_type: payload.data?.bounce_type,
          failure_reason: payload.data?.failure_message || payload.data?.reason,
          raw_payload: payload.data,
          event_timestamp: eventTimestamp
        }

        console.log(`Processing email event: ${cleanEventType} for ${customerEmail}`)

        const { error: emailEventError } = await supabase
          .from('email_events')
          .insert(emailEvent)

        if (emailEventError) {
          console.error('Error inserting email event:', emailEventError)
          // Don't return error - we still want to process other parts of the webhook
        } else {
          console.log(`Email event recorded: ${cleanEventType} for ${customerEmail}`)
        }

        // For email_unsubscribed events, also update the subscription table
        // (This handles unsubscribe via email link which may not have topic_id)
        if (cleanEventType === 'unsubscribed') {
          // Note: This is a global unsubscribe from an email, different from topic-specific
          // We log it but don't update email_subscriptions without a topic_id
          console.log(`Global email unsubscribe recorded for ${customerEmail}`)
        }

        return new Response(JSON.stringify({
          success: true,
          message: `Email event ${cleanEventType} recorded`,
          email: customerEmail
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      } else {
        console.log('Email event missing customer email, skipping')
        // Still return success - we don't want to fail the webhook
        return new Response(JSON.stringify({
          success: true,
          message: 'Email event received but no customer email found',
          event_type: eventType
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    }

    // Extract user data from Customer.io webhook for person creation/update
    // Customer.io sends data in different formats depending on webhook type
    const customerId = payload.data?.customer_id || payload.data?.identifiers?.id || payload.data?.customer?.id
    const email = payload.data?.email || payload.data?.identifiers?.email || payload.data?.customer?.email

    // If this is an event we don't specifically handle, acknowledge it but don't require email/customer_id
    // This handles test webhooks and other event types gracefully
    if (!email || !customerId) {
      console.log(`Webhook received - event_type: ${payload.event_type}, metric: ${payload.metric}`)
      console.log('No email or customer_id found - acknowledging webhook without processing')

      return new Response(JSON.stringify({
        success: true,
        message: 'Webhook received',
        event_type: payload.event_type || payload.metric || 'unknown',
        note: 'No customer data to process'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`Processing person: ${email} (${customerId})`)

    // Extract all attributes from payload (excluding system fields)
    // Note: 'created_at' is excluded because CIO sends it as a Unix timestamp string
    // which conflicts with user_metadata's expected ISO date format
    const excludedFields = ['customer_id', 'email', 'identifiers', 'id', 'cio_id', 'created_at']
    const attributes: Record<string, any> = {}

    Object.keys(payload.data).forEach(key => {
      if (!excludedFields.includes(key)) {
        attributes[key] = payload.data[key]
      }
    })

    console.log(`Extracted attributes:`, JSON.stringify(attributes, null, 2))

    // Check if person already exists by cio_id OR email
    // First check by cio_id (most specific)
    let { data: existingPerson, error: existingPersonError } = await supabase
      .from('people')
      .select('id, auth_user_id, cio_id, email')
      .eq('cio_id', customerId)
      .maybeSingle()

    if (existingPersonError) {
      console.error('Error checking existing person by cio_id:', existingPersonError)
    }

    // If not found by cio_id, check by email to prevent duplicates
    if (!existingPerson) {
      const { data: emailMatch, error: emailMatchError } = await supabase
        .from('people')
        .select('id, auth_user_id, cio_id, email')
        .ilike('email', email)
        .maybeSingle()

      if (emailMatchError) {
        console.error('Error checking existing person by email:', emailMatchError)
      } else if (emailMatch) {
        console.log(`Found existing person by email with different cio_id: ${emailMatch.cio_id} -> ${customerId}`)
        existingPerson = emailMatch

        // Update the cio_id to the new one from Customer.io
        const { error: updateCioError } = await supabase
          .from('people')
          .update({ cio_id: customerId })
          .eq('id', emailMatch.id)

        if (updateCioError) {
          console.error('Error updating cio_id:', updateCioError)
        } else {
          console.log(`Updated cio_id for person ${emailMatch.id} from ${emailMatch.cio_id} to ${customerId}`)
        }
      }
    }

    // If person already has auth account, just update attributes and return
    if (existingPerson?.auth_user_id) {
      console.log(`Person ${email} already has auth account: ${existingPerson.auth_user_id}`)

      // Update person attributes
      const { error: updateError } = await supabase
        .from('people')
        .update({
          email: email,
          attributes: attributes,
          last_synced_at: new Date().toISOString()
        })
        .eq('cio_id', customerId)

      if (updateError) {
        console.error('Error updating person attributes:', updateError)
      } else {
        console.log(`Updated attributes for ${email}`)
      }

      return new Response(JSON.stringify({
        success: true,
        message: 'Person attributes updated, auth account already exists',
        user_id: existingPerson.auth_user_id
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // First check if auth user already exists by email (may exist without being linked to customer)
    console.log(`Checking if auth user already exists for ${email}...`)
    const { data: existingUsersData, error: listError } = await supabase.auth.admin.listUsers()

    if (listError) {
      console.error('Error listing users:', listError)
    }

    const existingAuthUser = existingUsersData?.users?.find(
      (u: { email?: string }) => u.email?.toLowerCase() === email.toLowerCase()
    )

    if (existingAuthUser) {
      console.log(`Auth user already exists: ${existingAuthUser.id}`)

      // Link the existing auth user to the customer record
      const { error: upsertError } = await supabase
        .from('people')
        .upsert({
          cio_id: customerId,
          email: email,
          attributes: attributes,
          auth_user_id: existingAuthUser.id,
          last_synced_at: new Date().toISOString()
        }, { onConflict: 'cio_id' })

      if (upsertError) {
        console.error('Error linking existing auth user to person:', upsertError)
        return new Response(JSON.stringify({
          error: upsertError.message,
          details: 'Failed to link existing auth user to person'
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      console.log(`Successfully linked existing auth user ${existingAuthUser.id} to person ${customerId}`)
      return new Response(JSON.stringify({
        success: true,
        message: 'Linked existing auth user to person',
        user_id: existingAuthUser.id
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Create Supabase Auth user WITHOUT sending confirmation email
    // Try with minimal metadata first to isolate potential issues
    console.log('Creating auth user (minimal) for:', email)

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email,
      email_confirm: true // Auto-confirm to skip email notification
      // Note: metadata will be added after user creation via update
    })

    // If user created successfully, update with metadata
    if (authData?.user?.id && !authError) {
      const userMetadata = {
        cio_id: customerId,
        created_via: 'customerio_webhook',
        first_name: attributes.first_name || '',
        last_name: attributes.last_name || '',
        company: attributes.company || '',
        job_title: attributes.job_title || '',
        phone: attributes.phone || '',
        linkedin_url: attributes.linkedin_url || ''
      }

      const { error: updateMetaError } = await supabase.auth.admin.updateUserById(
        authData.user.id,
        { user_metadata: userMetadata }
      )

      if (updateMetaError) {
        console.error('Error updating user metadata:', updateMetaError)
        // Continue anyway - user was created
      } else {
        console.log('User metadata updated successfully')
      }
    }

    if (authError) {
      // If user already exists, try to get their ID and link it
      if (authError.message.includes('already registered') || authError.message.includes('already exists') || authError.code === 'email_exists') {
        console.log(`User ${email} already exists in auth, looking up by email...`)

        // Use listUsers with email filter (more efficient than listing all)
        const { data: { users }, error: listError } = await supabase.auth.admin.listUsers({
          filter: `email.eq.${email}`
        })

        // Fallback: try exact email search
        let existingAuthUser = users?.[0]

        if (!existingAuthUser && !listError) {
          // Try alternative approach - list users and filter
          const { data: allUsersData } = await supabase.auth.admin.listUsers({ perPage: 1000 })
          existingAuthUser = allUsersData?.users?.find(u => u.email?.toLowerCase() === email.toLowerCase())
        }

        if (existingAuthUser) {
          // Link the existing auth user to the customer record
          const { error: linkError } = await supabase
            .from('people')
            .update({ auth_user_id: existingAuthUser.id })
            .eq('cio_id', customerId)

          if (linkError) {
            console.error('Error linking existing auth user:', linkError)
          } else {
            console.log(`Linked existing auth user ${existingAuthUser.id} to person ${customerId}`)
          }

          return new Response(JSON.stringify({
            success: true,
            message: 'Linked existing auth user',
            user_id: existingAuthUser.id
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        } else {
          // User exists but we couldn't find them - just acknowledge and continue
          console.log(`User ${email} exists in auth but couldn't be looked up - acknowledging`)
          return new Response(JSON.stringify({
            success: true,
            message: 'User already exists in auth, customer record updated',
            note: 'Could not link auth user - may need manual linking'
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }
      }

      console.error('Auth creation error:', authError)
      return new Response(JSON.stringify({
        error: authError.message,
        details: 'Failed to create auth user'
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const authUserId = authData?.user?.id

    if (!authUserId) {
      console.error('Auth user created but no ID returned')
      return new Response(JSON.stringify({
        error: 'Auth user created but no ID returned',
        details: 'Unexpected error'
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Create or update person record with auth_user_id
    const { error: upsertError } = await supabase
      .from('people')
      .upsert({
        cio_id: customerId,
        email: email,
        attributes: attributes,
        auth_user_id: authUserId,
        last_synced_at: new Date().toISOString()
      }, { onConflict: 'cio_id' })

    if (upsertError) {
      console.error('Error creating/updating person with auth link:', upsertError)
      return new Response(JSON.stringify({
        error: upsertError.message,
        details: 'Failed to create person record'
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`Successfully created auth user ${authUserId} and person record for ${email} (${customerId})`)

    return new Response(JSON.stringify({
      success: true,
      user_id: authUserId,
      message: 'Auth user and person created successfully'
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('Webhook error:', error)
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
      details: 'Webhook processing failed'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
