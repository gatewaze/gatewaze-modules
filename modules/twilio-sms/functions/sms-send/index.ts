import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ---------- Auth Verification ----------

async function verifyAuth(req: Request): Promise<boolean> {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return false

  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error } = await supabase.auth.getUser(token)
  return !error && !!user
}

// ---------- Twilio Config ----------

interface TwilioConfig {
  TWILIO_ACCOUNT_SID: string
  TWILIO_AUTH_TOKEN: string
  TWILIO_PHONE_NUMBER: string
}

async function loadTwilioConfig(): Promise<TwilioConfig> {
  const { data, error } = await supabase
    .from('installed_modules')
    .select('config')
    .eq('id', 'twilio-sms')
    .single()

  if (error || !data?.config) {
    throw new Error('Twilio SMS module is not configured. Please set credentials in admin settings.')
  }

  const config = data.config as Record<string, string>
  const sid = config.TWILIO_ACCOUNT_SID
  const token = config.TWILIO_AUTH_TOKEN
  const phone = config.TWILIO_PHONE_NUMBER

  if (!sid || !token || !phone) {
    throw new Error('Incomplete Twilio configuration. Account SID, Auth Token, and Phone Number are all required.')
  }

  return { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_PHONE_NUMBER: phone }
}

// ---------- Validation ----------

const E164_REGEX = /^\+[1-9]\d{1,14}$/

function validateE164(phone: string): boolean {
  return E164_REGEX.test(phone)
}

// ---------- Send SMS ----------

async function sendSms(
  to: string,
  body: string,
  metadata: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const config = await loadTwilioConfig()

  // Insert pending log entry
  const { data: logEntry, error: logErr } = await supabase
    .from('sms_send_log')
    .insert({
      to_number: to,
      body,
      status: 'pending',
      metadata: metadata ?? {},
    })
    .select('id')
    .single()

  if (logErr || !logEntry) {
    console.error('Failed to create sms_send_log entry:', logErr)
    throw new Error('Failed to create SMS log entry')
  }

  // Call Twilio REST API
  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}/Messages.json`
  const credentials = btoa(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`)

  const params = new URLSearchParams({
    To: to,
    From: config.TWILIO_PHONE_NUMBER,
    Body: body,
  })

  const twilioResponse = await fetch(twilioUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })

  const twilioData = await twilioResponse.json()

  if (!twilioResponse.ok) {
    const errorMessage = twilioData?.message || `Twilio API error (${twilioResponse.status})`

    await supabase
      .from('sms_send_log')
      .update({ status: 'failed', error_message: errorMessage })
      .eq('id', logEntry.id)

    throw new Error(errorMessage)
  }

  // Update log with success
  await supabase
    .from('sms_send_log')
    .update({ status: 'sent', twilio_sid: twilioData.sid })
    .eq('id', logEntry.id)

  return { success: true, twilio_sid: twilioData.sid }
}

// ---------- Main Handler ----------

export default async function (req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' }, 405)
  }

  const isAuthed = await verifyAuth(req)
  if (!isAuthed) {
    return jsonResponse({ error: 'UNAUTHORIZED', message: 'Authentication required' }, 401)
  }

  try {
    const { to, body, metadata } = await req.json()

    if (!to || typeof to !== 'string') {
      return jsonResponse({ error: 'VALIDATION_ERROR', message: '"to" is required and must be a string' }, 400)
    }

    if (!validateE164(to)) {
      return jsonResponse({
        error: 'VALIDATION_ERROR',
        message: '"to" must be a valid E.164 phone number (e.g. +14155551234)',
      }, 400)
    }

    if (!body || typeof body !== 'string') {
      return jsonResponse({ error: 'VALIDATION_ERROR', message: '"body" is required and must be a string' }, 400)
    }

    if (body.length > 1600) {
      return jsonResponse({ error: 'VALIDATION_ERROR', message: '"body" must be 1600 characters or fewer' }, 400)
    }

    const result = await sendSms(to, body, metadata)
    return jsonResponse(result)
  } catch (error) {
    console.error('Error sending SMS:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return jsonResponse({ error: 'SEND_FAILED', message }, 500)
  }
}
