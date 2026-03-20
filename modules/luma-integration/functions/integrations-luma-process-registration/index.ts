import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  createFullRegistration as sharedCreateFullRegistration,
  cancelRegistration as sharedCancelRegistration,
  type RegistrationData,
  type EventData,
} from '../_shared/lumaRegistration.ts'

/**
 * Process Luma Registration Email
 *
 * This edge function receives inbound emails from SendGrid Inbound Parse
 * when someone registers for or cancels a Luma event and the notification
 * email is forwarded to our system.
 *
 * Registration email format: "{Name} has registered for {Event Name}."
 * Cancellation email format: "{Name} ({email}) cancelled their registration for {Event Name}."
 *
 * The plain text body contains full URLs with evt-XXX and usr-XXX IDs.
 * The Reply-To header contains the registrant's email address.
 *
 * Simplified flow:
 * 1. Detect if this is a registration or cancellation
 * 2. Extract registrant email from Reply-To header (or body for cancellations)
 * 3. Extract evt-XXX from email body URLs
 * 4. Look up event by luma_event_id
 * 5. Create or cancel registration if event exists
 *
 * Note: Person attributes (first_name, last_name, phone) can be enriched
 * later when the event owner uploads the Event Guests CSV from Luma.
 *
 * For premium Luma calendars, use the process-luma-webhook function instead,
 * which provides real-time registration syncing via webhooks with richer data.
 * See: supabase/functions/process-luma-webhook/index.ts
 */

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const customerioSiteId = Deno.env.get('CUSTOMERIO_SITE_ID')
const customerioApiKey = Deno.env.get('CUSTOMERIO_API_KEY')

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

interface SendGridInboundEmail {
  // SendGrid Inbound Parse fields (form data)
  from: string
  to: string
  subject: string
  text: string        // Plain text body
  html: string        // HTML body
  envelope: string    // JSON string with from/to
  headers: string     // Email headers
  sender_ip: string
  spam_score?: string
  spam_report?: string
  dkim?: string
  SPF?: string
  // Custom parsed fields
  replyTo?: string    // Reply-To header contains registrant's email
}

interface ParsedRegistration {
  userName: string
  eventName: string
  registrantEmail: string | null  // From Reply-To header or body for cancellations
  lumaEventId: string | null
  lumaUserId: string | null       // usr-XXX from email body URLs
  isCancellation: boolean
  ticketType: string | null       // e.g., "Early Bird Ticket"
  ticketQuantity: number          // Number of tickets purchased (default 1)
  ticketAmount: number | null     // Amount paid in cents (e.g., 30000 for $300.00)
  registrationAnswers: Array<{ label: string; value: any; answer: any; question_type?: string }>
  trackingSessionId: string | null // From UTM source in email body
}

/**
 * Extract Luma event ID directly from email text
 * The plain text version contains full URLs like:
 * https://luma.com/event/manage/evt-A8hBdeYpE2NbsKm/guests?uid=usr-KRAeARmm3tu7IqP
 */
function extractLumaEventIdFromText(text: string): string | null {
  const match = text?.match(/evt-[A-Za-z0-9]+/)
  return match ? match[0] : null
}

/**
 * Extract Luma user ID directly from email text
 * The plain text version contains full URLs like:
 * https://luma.com/event/manage/evt-A8hBdeYpE2NbsKm/guests?uid=usr-KRAeARmm3tu7IqP
 */
function extractLumaUserIdFromText(text: string): string | null {
  const match = text?.match(/usr-[A-Za-z0-9]+/)
  return match ? match[0] : null
}

/**
 * Extract Reply-To email from headers
 * This contains the registrant's email address
 */
function extractReplyToEmail(headers: string, replyTo?: string): string | null {
  // First check if replyTo was directly provided as a form field
  if (replyTo) {
    // Extract email from format like "Name <email@domain.com>" or just "email@domain.com"
    const emailMatch = replyTo.match(/<?([^\s<>]+@[^\s<>]+)>?/)
    if (emailMatch) {
      return emailMatch[1].toLowerCase()
    }
  }

  // Parse Reply-To from the headers string (SendGrid sends all headers as a single field)
  if (headers) {
    // Normalize line endings
    const normalizedHeaders = headers.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

    // Split into lines and find Reply-To
    const lines = normalizedHeaders.split('\n')
    for (const line of lines) {
      if (line.toLowerCase().startsWith('reply-to:')) {
        const value = line.substring('reply-to:'.length).trim()
        // Extract email from the value (handles "Name <email>" or just "email")
        const emailMatch = value.match(/<?([^\s<>]+@[^\s<>]+)>?/)
        if (emailMatch) {
          return emailMatch[1].toLowerCase()
        }
      }
    }

    // Fallback: regex match for Reply-To anywhere in headers
    const replyToMatch = headers.match(/Reply-To:\s*<?([^\s<>@]+@[^\s<>\r\n]+)>?/i)
    if (replyToMatch) {
      return replyToMatch[1].toLowerCase()
    }
  }

  return null
}

/**
 * Extract user name from email body
 *
 * Luma registration email format:
 * ```
 * Dan Baker
 * registered for your event
 *
 * Dan Baker [https://luma.com/...] has registered for Office Party.
 * ```
 *
 * Luma cancellation email format:
 * ```
 * Dan Baker (dan@example.com) cancelled their registration for Office Party.
 * ```
 *
 * The name appears:
 * 1. On the first line when second line contains "registered" or "cancelled"
 * 2. Before [URL] in the "{Name} [URL] has registered for" pattern
 * 3. Before (email) in cancellation format
 */
function extractUserName(text: string): string | null {
  if (!text) return null

  const lines = text.split(/[\r\n]+/).map(line => line.trim()).filter(Boolean)

  // Strategy 1: Name on first line, "registered", "cancelled", or "declined" on second line
  // This handles the Luma format where first line is just the name
  if (lines.length >= 2) {
    const firstLine = lines[0]
    const secondLine = lines[1].toLowerCase()
    if ((secondLine.includes('registered') || secondLine.includes('cancelled') || secondLine.includes('declined')) &&
        /^[\p{L}\s\-'.]+$/u.test(firstLine) && firstLine.length < 100) {
      return firstLine
    }
  }

  // Strategy 2: Get the name from "{Name} [URL] has registered for" pattern
  // This handles: "Dan Baker [https://...] has registered for Office Party."
  // Use [^\r\n\[] to match name characters but NOT newlines or brackets
  const urlPatternMatch = text.match(/([^\r\n\[]+?)\s*\[https?:\/\/[^\]]+\]\s*has registered for/im)
  if (urlPatternMatch) {
    const name = urlPatternMatch[1].trim()
    // Validate it looks like a name (letters, spaces, hyphens, apostrophes, periods)
    if (/^[\p{L}\s\-'.]+$/u.test(name) && name.length < 100) {
      return name
    }
  }

  // Strategy 3: Get the name from cancellation/decline format "{Name} ({email}) cancelled/declined"
  const cancellationMatch = text.match(/([\p{L}\s\-'.]+?)\s*\([^\s@]+@[^\s)]+\)\s*(?:cancelled|declined)/imu)
  if (cancellationMatch) {
    return cancellationMatch[1].trim()
  }

  // Strategy 4: Original pattern - name directly before "has registered for"
  const directMatch = text.match(/^([\p{L}\s\-'.]+?)\s+has registered for/imu)
  if (directMatch) {
    return directMatch[1].trim()
  }

  return null
}

/**
 * Extract event name from email body
 * Formats:
 *   "{Name} has registered for {Event}."
 *   "{Name} cancelled their registration for {Event}."
 *   "{Name} declined their invitation to {Event}."
 */
function extractEventName(text: string): string | null {
  // Try registration format first
  let match = text?.match(/has registered for\s+([^.]+)\./i)
  if (match) return match[1].trim()

  // Try cancellation format
  match = text?.match(/cancelled their registration for\s+([^.]+)\./i)
  if (match) return match[1].trim()

  // Try decline format
  match = text?.match(/declined their invitation to\s+([^.]+)\./i)
  return match ? match[1].trim() : null
}

/**
 * Check if the email is a cancellation or decline notification
 * Formats:
 *   "{Name} cancelled their registration"
 *   "{Name} declined their invitation"
 */
function isCancellationEmail(text: string): boolean {
  return /cancelled their registration|declined their invitation/i.test(text || '')
}

/**
 * Extract ticket type, quantity, and amount from email
 *
 * Plain text format: "Ticket: Early Bird Ticket - $300.00"
 * Multi-ticket format: "Ticket: 4× General Admission Ticket - $1,600.00"
 * Also handles: "They paid $1,600.00 for their 4 tickets."
 *
 * Returns ticket type (e.g., "General Admission Ticket"), quantity, and amount in cents
 */
function extractTicketInfo(text: string, html: string): { ticketType: string | null; ticketQuantity: number; ticketAmount: number | null } {
  let ticketType: string | null = null
  let ticketQuantity = 1
  let ticketAmount: number | null = null

  // Strategy 1: Plain text "Ticket: {Type} - ${Amount}" format
  // Handles both "Ticket: Early Bird - $300" and "Ticket: 4× General Admission - $1,600"
  const ticketLineMatch = text?.match(/Ticket:\s*(.+?)\s*-\s*\$([0-9,]+(?:\.[0-9]{2})?)/i)
  if (ticketLineMatch) {
    ticketType = ticketLineMatch[1].trim()
    const amountStr = ticketLineMatch[2].replace(/,/g, '')
    ticketAmount = Math.round(parseFloat(amountStr) * 100)
  }

  // Strategy 2: HTML structure with ticket name and price in separate divs
  if (!ticketType && html) {
    const htmlTicketMatch = html.match(/font-weight:500[^>]*>\s*([^<]+)<\/div>\s*<div[^>]*>\s*\$([0-9,]+(?:\.[0-9]{2})?)/i)
    if (htmlTicketMatch) {
      ticketType = htmlTicketMatch[1].trim()
      const amountStr = htmlTicketMatch[2].replace(/,/g, '')
      ticketAmount = Math.round(parseFloat(amountStr) * 100)
    }
  }

  // Strategy 3: Extract amount from "They paid $X for their N ticket" if we don't have it yet
  if (ticketAmount === null && text) {
    const paidMatch = text.match(/They paid \$([0-9,]+(?:\.[0-9]{2})?)\s+for their/i)
    if (paidMatch) {
      const amountStr = paidMatch[1].replace(/,/g, '')
      ticketAmount = Math.round(parseFloat(amountStr) * 100)
    }
  }

  // Extract quantity from ticket type string: "4× General Admission Ticket" or "4x General Admission Ticket"
  if (ticketType) {
    const qtyMatch = ticketType.match(/^(\d+)\s*[×x]\s*/i)
    if (qtyMatch) {
      ticketQuantity = parseInt(qtyMatch[1], 10)
      ticketType = ticketType.replace(/^\d+\s*[×x]\s*/i, '').trim()
    }
  }

  // Also try to extract quantity from "They paid $X for their N tickets" as fallback
  if (ticketQuantity === 1 && text) {
    const ticketCountMatch = text.match(/for their (\d+) tickets?\./i)
    if (ticketCountMatch) {
      ticketQuantity = parseInt(ticketCountMatch[1], 10)
    }
  }

  return { ticketType, ticketQuantity, ticketAmount }
}

/**
 * Extract UTM source / custom_source from email body
 * Format: "UTM source for the registration was {value}."
 */
function extractUtmSource(text: string): string | null {
  const match = text?.match(/UTM source for the registration was\s+([^\s.]+)/i)
  return match ? match[1] : null
}

/**
 * Extract tracking session ID from a custom_source value
 * Format: "{platform}__{session_id}" e.g. "meta__ml7xo47p-dmsby75m"
 */
function extractTrackingSessionId(customSource: string): string | null {
  if (customSource?.includes('__')) {
    return customSource.split('__')[1] || null
  }
  return null
}

/**
 * Extract registration question/answer pairs from email body
 *
 * Luma emails contain Q&A after the registration sentence, formatted as:
 *   {Question}
 *   {Answer}
 *
 * Questions typically end with ? or are known patterns (e.g. sponsor opt-out).
 * The section ends when we hit a line that looks like an email footer/separator.
 */
function extractRegistrationAnswers(text: string): Array<{
  label: string
  value: any
  answer: any
  question_type?: string
}> {
  if (!text) return []

  const answers: Array<{ label: string; value: any; answer: any; question_type?: string }> = []

  // Find the Q&A section: after "has registered for {Event}." or after "UTM source" line
  // Split into lines and find the start of the Q&A block
  const lines = text.split(/\r?\n/)

  let startIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    // Start after UTM source line or "has registered for" line
    if (/UTM source for the registration was/i.test(line)) {
      startIdx = i + 1
      break
    }
    if (/has registered for\s+.+\./i.test(line)) {
      startIdx = i + 1
    }
  }

  if (startIdx === -1) return answers

  // Parse Q&A pairs: question line followed by answer line
  let i = startIdx
  while (i < lines.length) {
    const line = lines[i].trim()

    // Skip empty lines
    if (!line) {
      i++
      continue
    }

    // Stop at footer markers
    if (/^(--|===|___|\*\*\*|Manage your event|View event|Powered by|lu\.ma)/i.test(line)) break
    if (/^(Reply to this|You are receiving|Unsubscribe|View in browser)/i.test(line)) break

    // Check if this looks like a question (ends with ? or is a known pattern)
    const isQuestion = line.endsWith('?') ||
      /^I do not want|^I don't want/i.test(line) ||
      /^(Do you|What is|What's|Which|How|Where|When|Are you|Have you|Will you|Can you|Please|Tell us)/i.test(line)

    if (isQuestion) {
      // The next non-empty line is the answer
      let answerLine = ''
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++ // skip empty lines
      if (j < lines.length) {
        answerLine = lines[j].trim()
        // Don't treat another question as an answer
        if (answerLine.endsWith('?') || /^I do not want/i.test(answerLine)) {
          // No answer provided for this question, skip
          i++
          continue
        }
      }

      // Infer question_type from the label
      const label = line
      let question_type = 'text'
      let value: any = answerLine

      if (/linkedin/i.test(label)) {
        question_type = 'linkedin'
      } else if (/company|work for/i.test(label) && !/sponsor/i.test(label)) {
        question_type = 'company'
      } else if (/do not want.*shared|not.*information.*shared.*sponsor/i.test(label)) {
        question_type = 'agree-check'
        // Convert "Agreed" to boolean true
        value = answerLine.toLowerCase() === 'agreed' ? true : answerLine
      }

      answers.push({ label, value, answer: answerLine, question_type })
      i = j + 1 // Skip past the answer line
      continue
    }

    // If it doesn't look like a question, skip this line
    i++
  }

  return answers
}

/**
 * Extract email from cancellation/decline body text
 * Formats:
 *   "{Name} ({email}) cancelled their registration for {Event}."
 *   "{Name} ({email}) declined their invitation to {Event}."
 */
function extractCancellationEmail(text: string): string | null {
  const match = text?.match(/\(([^\s<>()]+@[^\s<>()]+)\)\s+(?:cancelled their registration|declined their invitation)/i)
  return match ? match[1].toLowerCase() : null
}


/**
 * Parse the inbound email and extract registration data
 */
function parseRegistrationEmail(email: SendGridInboundEmail): ParsedRegistration {
  const isCancellation = isCancellationEmail(email.text)
  const userName = extractUserName(email.text) || 'Unknown'
  const eventName = extractEventName(email.text) || 'Unknown Event'

  // For cancellations, extract email from body text (format: "Name (email) cancelled...")
  // For registrations, extract from Reply-To header
  let registrantEmail: string | null = null
  if (isCancellation) {
    registrantEmail = extractCancellationEmail(email.text)
  }
  // If not found in body (or it's a registration), try Reply-To header
  if (!registrantEmail) {
    registrantEmail = extractReplyToEmail(email.headers, email.replyTo)
  }

  // Extract event ID and user ID from plain text URLs
  const lumaEventId = extractLumaEventIdFromText(email.text)
  const lumaUserId = extractLumaUserIdFromText(email.text)

  // Extract ticket type, quantity, and amount
  const { ticketType, ticketQuantity, ticketAmount } = extractTicketInfo(email.text, email.html)

  // Extract registration question/answer pairs from email body
  const registrationAnswers = extractRegistrationAnswers(email.text)

  // Extract tracking session ID from UTM source
  const utmSource = extractUtmSource(email.text)
  const trackingSessionId = utmSource ? extractTrackingSessionId(utmSource) : null

  return {
    userName,
    eventName,
    registrantEmail,
    lumaEventId,
    lumaUserId,
    isCancellation,
    ticketType,
    ticketQuantity,
    ticketAmount,
    registrationAnswers,
    trackingSessionId,
  }
}

/**
 * Store a pending registration in luma_pending_registrations table
 * This is called for ALL registrations, even if no matching event exists yet
 */
async function storePendingRegistration(
  parsed: ParsedRegistration,
  emailData: SendGridInboundEmail,
  internalEventId: string | null
): Promise<{ id: string; isNew: boolean }> {
  // Check if we already have this registration (by luma_event_id + email)
  const { data: existing } = await supabase
    .from('integrations_luma_pending_registrations')
    .select('id, status')
    .eq('luma_event_id', parsed.lumaEventId!)
    .eq('matched_email', parsed.registrantEmail!)
    .maybeSingle()

  if (existing) {
    // Update existing record based on whether it's a cancellation or re-registration
    if (parsed.isCancellation) {
      await supabase
        .from('integrations_luma_pending_registrations')
        .update({
          status: 'cancelled',
          registration_action: 'cancelled',
          user_name: parsed.userName || existing.user_name,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
    } else {
      // Re-registration: update status back to registered
      await supabase
        .from('integrations_luma_pending_registrations')
        .update({
          status: internalEventId ? 'pending' : 'no_event',
          registration_action: 'registered',
          user_name: parsed.userName || existing.user_name,
          luma_user_id: parsed.lumaUserId || 'unknown',
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
    }
    return { id: existing.id, isNew: false }
  }

  // Insert new pending registration
  const { data: newRecord, error } = await supabase
    .from('integrations_luma_pending_registrations')
    .insert({
      luma_user_id: parsed.lumaUserId || 'unknown',
      luma_event_id: parsed.lumaEventId!,
      user_name: parsed.userName,
      matched_email: parsed.registrantEmail,
      matched_via: 'reply_to_header',
      status: internalEventId ? 'pending' : 'no_event',
      registration_action: parsed.isCancellation ? 'cancelled' : 'registered',
      email_received_at: new Date().toISOString(),
      email_from: emailData.from,
      email_to: emailData.to,
      email_subject: emailData.subject,
      raw_email_data: {
        text: emailData.text?.substring(0, 5000), // Limit size
        headers: emailData.headers?.substring(0, 2000),
        ticket_type: parsed.ticketType,
        ticket_amount: parsed.ticketAmount,
      },
    })
    .select('id')
    .single()

  if (error) {
    console.error('Failed to store pending registration:', error)
    throw new Error(`Failed to store pending registration: ${error.message}`)
  }

  return { id: newRecord.id, isNew: true }
}


Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Only allow POST (SendGrid sends POST requests)
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  try {
    // SendGrid Inbound Parse sends data as multipart/form-data
    const contentType = req.headers.get('content-type') || ''
    let emailData: SendGridInboundEmail

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData()
      emailData = {
        from: formData.get('from') as string || '',
        to: formData.get('to') as string || '',
        subject: formData.get('subject') as string || '',
        text: formData.get('text') as string || '',
        html: formData.get('html') as string || '',
        envelope: formData.get('envelope') as string || '',
        headers: formData.get('headers') as string || '',
        sender_ip: formData.get('sender_ip') as string || '',
        spam_score: formData.get('spam_score') as string || undefined,
        spam_report: formData.get('spam_report') as string || undefined,
        dkim: formData.get('dkim') as string || undefined,
        SPF: formData.get('SPF') as string || undefined,
        // Reply-To contains the registrant's email
        replyTo: formData.get('Reply-To') as string || formData.get('reply-to') as string || undefined,
      }
    } else {
      // Fallback to JSON (for testing)
      emailData = await req.json()
    }

    console.log('Processing Luma email:', {
      from: emailData.from,
      to: emailData.to,
      subject: emailData.subject,
      hasHeaders: !!emailData.headers,
      headersLength: emailData.headers?.length || 0,
      replyToField: emailData.replyTo,
    })

    // Log the headers for debugging Reply-To extraction
    if (emailData.headers) {
      // Find Reply-To line in headers
      const replyToLine = emailData.headers.split('\n').find(line => line.toLowerCase().startsWith('reply-to:'))
      console.log('Reply-To header line:', replyToLine || 'NOT FOUND')
    }

    // Parse the email to extract registration data
    const parsed = parseRegistrationEmail(emailData)

    console.log('Parsed email:', {
      userName: parsed.userName,
      eventName: parsed.eventName,
      registrantEmail: parsed.registrantEmail,
      lumaEventId: parsed.lumaEventId,
      lumaUserId: parsed.lumaUserId,
      isCancellation: parsed.isCancellation,
      ticketType: parsed.ticketType,
      ticketQuantity: parsed.ticketQuantity,
      ticketAmount: parsed.ticketAmount,
    })

    // Validate we have the essential data
    if (!parsed.registrantEmail) {
      console.error('No registrant email found in Luma notification')
      return new Response(JSON.stringify({
        success: false,
        error: 'No registrant email found in Luma notification',
      }), {
        status: 200, // Return 200 so SendGrid doesn't retry
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!parsed.lumaEventId) {
      console.error('Could not extract Luma event ID from email')
      return new Response(JSON.stringify({
        success: false,
        error: 'Could not extract Luma event ID from email',
      }), {
        status: 200, // Return 200 so SendGrid doesn't retry
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Look up the event by luma_event_id (may not exist yet)
    const { data: event } = await supabase
      .from('events')
      .select('event_id, event_city, event_country_code, venue_address, cvent_event_id, cvent_admission_item_id, cvent_sync_enabled')
      .eq('luma_event_id', parsed.lumaEventId)
      .maybeSingle()

    // Look up per-event marketing consent setting
    let registrantMarketingConsent = false
    if (event) {
      const { data: commSettings } = await supabase
        .from('events_communication_settings')
        .select('registrant_marketing_consent')
        .eq('event_id', event.event_id)
        .maybeSingle()
      registrantMarketingConsent = commSettings?.registrant_marketing_consent === true
    }

    // Store the pending registration FIRST (always, even if no event exists)
    const pendingReg = await storePendingRegistration(
      parsed,
      emailData,
      event?.event_id || null
    )

    console.log('Stored pending registration:', {
      pendingId: pendingReg.id,
      isNew: pendingReg.isNew,
      hasEvent: !!event,
    })

    // If no event exists yet, store for later processing when event is added
    if (!event) {
      console.log(`No event found with luma_event_id: ${parsed.lumaEventId} - stored for later processing`)
      return new Response(JSON.stringify({
        success: true,
        action: 'stored_pending',
        message: 'Registration stored - will be processed when event is added',
        pendingRegistrationId: pendingReg.id,
        registrantEmail: parsed.registrantEmail,
        lumaEventId: parsed.lumaEventId,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Handle cancellation
    if (parsed.isCancellation) {
      console.log(`Cancelling registration for ${parsed.registrantEmail} at event ${event.event_id}`)

      const cancellationResult = await sharedCancelRegistration(
        supabase,
        parsed.registrantEmail,
        event.event_id
      )

      // Update pending registration status
      await supabase
        .from('integrations_luma_pending_registrations')
        .update({
          status: 'cancelled',
          processed_at: new Date().toISOString(),
        })
        .eq('id', pendingReg.id)

      if (!cancellationResult.success) {
        console.error('Failed to cancel registration:', cancellationResult.error)
        return new Response(JSON.stringify({
          success: false,
          error: cancellationResult.error,
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      console.log('Registration cancelled successfully:', {
        registrationId: cancellationResult.registrationId,
        previousStatus: cancellationResult.previousStatus,
      })

      return new Response(JSON.stringify({
        success: true,
        action: 'cancelled',
        registrantEmail: parsed.registrantEmail,
        lumaEventId: parsed.lumaEventId,
        eventId: event.event_id,
        registrationId: cancellationResult.registrationId,
        previousStatus: cancellationResult.previousStatus,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Create the registration
    console.log(`Creating registration for ${parsed.registrantEmail} at event ${event.event_id}`)

    const registrationData: RegistrationData = {
      email: parsed.registrantEmail,
      fullName: parsed.userName,
      lumaUserId: parsed.lumaUserId || undefined,
      ticketType: parsed.ticketType || undefined,
      ticketQuantity: parsed.ticketQuantity > 1 ? parsed.ticketQuantity : undefined,
      ticketAmount: parsed.ticketAmount || undefined,
      registrationAnswers: parsed.registrationAnswers.length > 0 ? parsed.registrationAnswers : undefined,
      trackingSessionId: parsed.trackingSessionId || undefined,
      source: 'luma_email_notification',
    }

    const eventData: EventData = {
      eventId: event.event_id,
      eventCity: event.event_city,
      eventCountryCode: event.event_country_code,
      venueAddress: event.venue_address,
      cventEventId: event.cvent_sync_enabled ? event.cvent_event_id : null,
      cventAdmissionItemId: event.cvent_sync_enabled ? event.cvent_admission_item_id : null,
    }

    const registrationResult = await sharedCreateFullRegistration(
      supabase,
      registrationData,
      eventData,
      customerioSiteId || undefined,
      customerioApiKey || undefined,
      registrantMarketingConsent
    )

    if (!registrationResult.success) {
      console.error('Failed to create registration:', registrationResult.error)
      return new Response(JSON.stringify({
        success: false,
        error: registrationResult.error,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Update pending registration with created IDs
    await supabase
      .from('integrations_luma_pending_registrations')
      .update({
        status: 'processed',
        processed_at: new Date().toISOString(),
        created_person_id: registrationResult.personId,
        created_people_profile_id: registrationResult.memberProfileId,
        created_registration_id: registrationResult.registrationId,
      })
      .eq('id', pendingReg.id)

    console.log('Registration created successfully:', {
      personId: registrationResult.personId,
      memberProfileId: registrationResult.memberProfileId,
      registrationId: registrationResult.registrationId,
    })

    return new Response(JSON.stringify({
      success: true,
      action: 'registered',
      registrantEmail: parsed.registrantEmail,
      lumaEventId: parsed.lumaEventId,
      eventId: event.event_id,
      personId: registrationResult.personId,
      memberProfileId: registrationResult.memberProfileId,
      registrationId: registrationResult.registrationId,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error: any) {
    console.error('Error processing Luma registration email:', error)
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Internal server error'
    }), {
      status: 200, // Return 200 so SendGrid doesn't retry indefinitely
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
