// @ts-nocheck — Deno edge function
/**
 * speakers-public-api
 *
 * Anonymous public endpoints for the speakers rollup:
 *   POST /calendars/:slug/talks        — submit a talk to a calendar
 *   GET  /talks/:editToken             — view own submission
 *   PATCH /talks/:editToken            — edit own submission
 *   DELETE /talks/:editToken           — withdraw own submission
 *
 * Per spec-speakers-rollup.md §6.1.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
}

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, error: null }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
function err(status: number, code: string, message: string, details?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ data: null, error: { code, message, details } }),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

function generateToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function maskEmail(email: string | null): string | null {
  if (!email) return null
  const at = email.indexOf('@')
  if (at < 1) return email
  const local = email.substring(0, at)
  return (local.length <= 2 ? local[0] + '***' : local[0] + '***' + local[local.length - 1]) + email.substring(at)
}

// ---- POST /calendars/:slug/talks ----
async function submitTalk(slug: string, body: any, captchaToken: string | null): Promise<Response> {
  // TODO: verify hCaptcha / Turnstile token in production
  if (!captchaToken && !Deno.env.get('SKIP_CAPTCHA')) {
    return err(400, 'CAPTCHA_FAILED', 'Captcha verification failed.')
  }

  const speaker = body?.speaker || {}
  const talk = body?.talk || {}

  if (!speaker.name || typeof speaker.name !== 'string') {
    return err(400, 'INVALID_INPUT', 'speaker.name required', { field: 'speaker.name' })
  }
  if (!speaker.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(speaker.email)) {
    return err(400, 'INVALID_INPUT', 'valid speaker.email required', { field: 'speaker.email' })
  }
  if (!talk.title || typeof talk.title !== 'string') {
    return err(400, 'INVALID_INPUT', 'talk.title required', { field: 'talk.title' })
  }
  if (!talk.synopsis || typeof talk.synopsis !== 'string') {
    return err(400, 'INVALID_INPUT', 'talk.synopsis required', { field: 'talk.synopsis' })
  }
  const synLen = talk.synopsis.length
  if (synLen < 100 || synLen > 2000) {
    return err(400, 'INVALID_INPUT', 'Synopsis must be 100–2000 characters.', { field: 'talk.synopsis', length: synLen })
  }

  // Resolve the calendar by slug
  const { data: cal, error: calErr } = await supabase
    .from('calendars')
    .select('id, name, slug, visibility, is_active')
    .or(`slug.eq.${slug},calendar_id.eq.${slug}`)
    .eq('is_active', true)
    .eq('visibility', 'public')
    .maybeSingle()

  if (calErr || !cal) {
    return err(404, 'CALENDAR_NOT_FOUND', 'No public calendar with that slug.')
  }

  // Find or create speaker profile by email
  const emailLower = speaker.email.toLowerCase().trim()
  let speakerProfileId: string | null = null
  const { data: existingProfile } = await supabase
    .from('events_speaker_profiles')
    .select('id, canonical_profile_id')
    .ilike('email', emailLower)
    .maybeSingle()

  if (existingProfile) {
    speakerProfileId = (existingProfile as any).canonical_profile_id || (existingProfile as any).id
  } else {
    const { data: newProfile, error: insertErr } = await supabase
      .from('events_speaker_profiles')
      .insert({
        name: speaker.name,
        email: speaker.email,
        title: speaker.title,
        company: speaker.company,
        bio: speaker.bio,
        linkedin_url: speaker.linkedin_url,
        twitter_url: speaker.twitter_url,
        website_url: speaker.website_url,
      })
      .select('id')
      .single()
    if (insertErr || !newProfile) {
      return err(500, 'INTERNAL', insertErr?.message || 'Could not create speaker profile')
    }
    speakerProfileId = (newProfile as any).id
  }

  // Check for existing pending submission by this speaker to this calendar
  // within the last 24 hours (idempotency)
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const { data: existingTalk } = await supabase
    .from('events_talks')
    .select('id, edit_token')
    .eq('calendar_id', (cal as any).id)
    .eq('submitter_email', speaker.email)
    .eq('status', 'pending')
    .gte('submitted_at', since)
    .maybeSingle()

  if (existingTalk) {
    return ok({
      talk_id: (existingTalk as any).id,
      edit_token: (existingTalk as any).edit_token,
      status: 'pending_email_confirmation',
      message: 'You already have a pending submission. We re-sent the confirmation email.',
    })
  }

  // Insert the talk with scope=calendar
  const editToken = generateToken()
  const { data: inserted, error: talkErr } = await supabase
    .from('events_talks')
    .insert({
      calendar_id: (cal as any).id,
      origin_calendar_id: (cal as any).id,
      scope: 'calendar',
      title: talk.title,
      synopsis: talk.synopsis,
      duration_minutes: talk.duration_minutes ?? 30,
      topics: talk.topics || [],
      available_from: talk.available_from || null,
      available_until: talk.available_until || null,
      submitter_email: speaker.email,
      submitter_name: speaker.name,
      status: 'pending',
      edit_token: editToken,
      submitted_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (talkErr || !inserted) {
    return err(500, 'INTERNAL', talkErr?.message || 'Could not submit talk')
  }

  // TODO: send confirmation email via email-send edge function
  console.log(`[speakers-public-api] would send confirmation email to ${speaker.email} for talk ${(inserted as any).id}`)

  return ok(
    {
      talk_id: (inserted as any).id,
      edit_token: editToken,
      status: 'pending_email_confirmation',
      message: 'Check your email to confirm your submission.',
    },
    201
  )
}

// ---- GET /talks/:editToken ----
async function viewTalk(token: string): Promise<Response> {
  const { data: talk } = await supabase
    .from('events_talks')
    .select('id, calendar_id, status, scope, title, synopsis, duration_minutes, topics, available_from, available_until, submitter_email, submitter_name, submitted_at, reviewed_at')
    .eq('edit_token', token)
    .maybeSingle()

  if (!talk) return err(410, 'INVALID_EDIT_TOKEN', 'Edit link is invalid or has expired.')

  // Look up calendar info
  let calendar = null
  if ((talk as any).calendar_id) {
    const { data: cal } = await supabase
      .from('calendars')
      .select('id, slug, name')
      .eq('id', (talk as any).calendar_id)
      .maybeSingle()
    calendar = cal
  }

  return ok({
    talk_id: (talk as any).id,
    calendar,
    scope: (talk as any).scope,
    status: (talk as any).status,
    talk: {
      title: (talk as any).title,
      synopsis: (talk as any).synopsis,
      duration_minutes: (talk as any).duration_minutes,
      topics: (talk as any).topics,
      available_from: (talk as any).available_from,
      available_until: (talk as any).available_until,
    },
    speaker: {
      name: (talk as any).submitter_name,
      email_masked: maskEmail((talk as any).submitter_email),
    },
    submitted_at: (talk as any).submitted_at,
    reviewed_at: (talk as any).reviewed_at,
    can_edit: (talk as any).status === 'pending' || (talk as any).status === 'accepted',
    can_withdraw: (talk as any).status !== 'withdrawn',
  })
}

async function editTalk(token: string, body: any): Promise<Response> {
  const { data: existing } = await supabase
    .from('events_talks')
    .select('id, status')
    .eq('edit_token', token)
    .maybeSingle()
  if (!existing) return err(410, 'INVALID_EDIT_TOKEN', 'Edit link is invalid or has expired.')
  if ((existing as any).status === 'withdrawn') {
    return err(403, 'WITHDRAW_NOT_ALLOWED', 'This talk has been withdrawn.')
  }

  const patch: Record<string, unknown> = {}
  const talk = body?.talk || {}
  if (talk.title) patch.title = talk.title
  if (talk.synopsis) patch.synopsis = talk.synopsis
  if (talk.duration_minutes) patch.duration_minutes = talk.duration_minutes
  if (talk.topics) patch.topics = talk.topics
  if (talk.available_from !== undefined) patch.available_from = talk.available_from
  if (talk.available_until !== undefined) patch.available_until = talk.available_until

  if (Object.keys(patch).length === 0) {
    return err(400, 'INVALID_INPUT', 'No updatable fields provided.')
  }

  const { error: updateErr } = await supabase
    .from('events_talks')
    .update(patch)
    .eq('edit_token', token)

  if (updateErr) return err(500, 'INTERNAL', updateErr.message)

  return viewTalk(token)
}

async function withdrawTalk(token: string): Promise<Response> {
  const { error: updateErr } = await supabase
    .from('events_talks')
    .update({ status: 'withdrawn' })
    .eq('edit_token', token)

  if (updateErr) return err(500, 'INTERNAL', updateErr.message)
  return ok({ status: 'withdrawn' })
}

// ---- Router ----
async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const url = new URL(req.url)
  const path = url.pathname
    .replace(/^\/functions\/v1\/speakers-public-api/, '')
    .replace(/^\/speakers-public-api/, '') || '/'

  try {
    // POST /calendars/:slug/talks
    const submitMatch = path.match(/^\/calendars\/([^/]+)\/talks$/)
    if (submitMatch && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      return await submitTalk(submitMatch[1], body, body?.captcha_token)
    }

    // GET/PATCH/DELETE /talks/:editToken
    const tokenMatch = path.match(/^\/talks\/([a-zA-Z0-9]+)$/)
    if (tokenMatch) {
      const token = tokenMatch[1]
      if (req.method === 'GET') return await viewTalk(token)
      if (req.method === 'PATCH') {
        const body = await req.json().catch(() => ({}))
        return await editTalk(token, body)
      }
      if (req.method === 'DELETE') return await withdrawTalk(token)
    }

    return err(404, 'NOT_FOUND', `Unknown route: ${req.method} ${path}`)
  } catch (e: any) {
    console.error('[speakers-public-api] Unhandled error:', e)
    return err(500, 'INTERNAL', e?.message || 'Unexpected error')
  }
}

Deno.serve(handler)
