import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

/**
 * send-test-inbound — SendGrid Inbound Parse receiver for the synthetic test
 * mailboxes.
 *
 * Deliberately separate from the platform's email-inbound-parse function. That
 * one is on the critical path for every production reply, and pushing a 25k
 * burst through it would risk reply handling; its broadcast/newsletter matchers
 * could also mis-claim test messages. Inbound Parse binds per hostname anyway,
 * so the test domain simply points here.
 *
 * On authentication: Inbound Parse has NO request signing. SendGrid's signed
 * webhook mechanism is for the Event Webhook only, so the URL token is the
 * strongest authentication available here. Do not go looking for a signature
 * header — it will never arrive.
 *
 * Storage policy: headers for everyone, bodies only for the small inspectable
 * sample. At 25k messages a run, bodies are bulk noise; for the first N
 * recipients they are what makes "open the message and click its real
 * unsubscribe link" possible.
 */

const MODULE_ID = 'send-testing'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// 25k/hour is ~7/sec; this only engages under abuse or a pathological burst.
// Excess gets 429, which SendGrid treats as a failed delivery and retries, so
// backpressure never costs us an arrival.
const RATE_LIMIT_PER_SEC = 50
const RATE_LIMIT_BURST = 200
let tokens = RATE_LIMIT_BURST
let lastRefill = Date.now()

function takeToken(): boolean {
  const now = Date.now()
  const elapsed = (now - lastRefill) / 1000
  if (elapsed > 0) {
    tokens = Math.min(RATE_LIMIT_BURST, tokens + elapsed * RATE_LIMIT_PER_SEC)
    lastRefill = now
  }
  if (tokens < 1) return false
  tokens -= 1
  return true
}

function serviceClient() {
  const url = Deno.env.get('SUPABASE_URL')!
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Constant-time compare so the URL token cannot be recovered by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Pulls the first bare address out of a To/Envelope value. */
function extractAddress(raw: string | null): string | null {
  if (!raw) return null
  const angle = /<([^>]+)>/.exec(raw)
  const candidate = (angle ? angle[1] : raw).trim().toLowerCase()
  const match = /[^\s,;<>]+@[^\s,;<>]+/.exec(candidate)
  return match ? match[0] : null
}

function headerValue(headers: string, name: string): string | null {
  // Header blocks are line-folded; join continuations before matching.
  const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    if (line.slice(0, idx).trim().toLowerCase() === name.toLowerCase()) {
      return line.slice(idx + 1).trim()
    }
  }
  return null
}

function parseAuthResults(headers: string): Record<string, string> {
  const raw = headerValue(headers, 'Authentication-Results')
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const mech of ['spf', 'dkim', 'dmarc']) {
    const m = new RegExp(`\\b${mech}=(\\w+)`, 'i').exec(raw)
    if (m) out[mech] = m[1].toLowerCase()
  }
  return out
}

/**
 * A SendGrid retry arrives late, so ingest time would overstate latency.
 * The topmost Received header carries when the message actually landed.
 */
function receivedAtFromHeaders(headers: string): string | null {
  const received = headerValue(headers, 'Received')
  if (!received) return null
  const semi = received.lastIndexOf(';')
  if (semi < 0) return null
  const ts = Date.parse(received.slice(semi + 1).trim())
  if (!Number.isFinite(ts)) return null
  // Guard against a forged far-future date skewing the window.
  if (ts > Date.now() + 60_000) return null
  return new Date(ts).toISOString()
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }

  if (!takeToken()) {
    return new Response('Slow down', { status: 429, headers: corsHeaders })
  }

  let supabase: ReturnType<typeof serviceClient>
  try {
    supabase = serviceClient()
  } catch {
    return new Response('Not configured', { status: 503, headers: corsHeaders })
  }

  // Config drives both the token check and the recipient allowlist, so read it
  // before touching the payload.
  const { data: installed } = await supabase
    .from('installed_modules')
    .select('config')
    .eq('id', MODULE_ID)
    .maybeSingle()

  const config = (installed?.config ?? {}) as Record<string, unknown>
  const domain = String(config.inbound_domain ?? '').trim().toLowerCase()
  const expectedToken = String(config.inbound_token ?? '').trim()
  const inspectableCount = Number(config.inspectable_count ?? 20)

  if (!domain || !expectedToken) {
    // Fail closed rather than accepting unauthenticated writes.
    return new Response('Not configured', { status: 503, headers: corsHeaders })
  }

  // Token lives in the URL because Inbound Parse cannot send headers of our
  // choosing. Accept it as a trailing path segment or a query parameter.
  const url = new URL(req.url)
  const segments = url.pathname.split('/').filter(Boolean)
  const pathToken = segments.length > 0 ? segments[segments.length - 1] : ''
  const queryToken = url.searchParams.get('token') ?? ''
  const presented = timingSafeEqual(pathToken, expectedToken) ? pathToken : queryToken

  if (!timingSafeEqual(presented, expectedToken)) {
    return new Response('Forbidden', { status: 403, headers: corsHeaders })
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    // Malformed payloads are dropped with 200: retrying will not fix them, and
    // a retry storm on a public endpoint is worse than a lost junk message.
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  const toRaw = (form.get('to') as string | null) ?? (form.get('envelope') as string | null)
  let recipient = extractAddress(toRaw)
  if (!recipient) {
    const envelope = form.get('envelope') as string | null
    if (envelope) {
      try {
        const parsed = JSON.parse(envelope) as { to?: string[] }
        recipient = extractAddress(parsed.to?.[0] ?? null)
      } catch {
        recipient = null
      }
    }
  }

  // Recipient allowlist. Anything else is not ours; 200 so SendGrid stops.
  if (!recipient || !recipient.endsWith(`@${domain}`) || !/^st-\d{6,}@/.test(recipient)) {
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  const headers = (form.get('headers') as string | null) ?? ''
  const subject = (form.get('subject') as string | null) ?? null
  const dateHeader = headerValue(headers, 'Date')

  // Dedupe key. Message-ID when present; otherwise a deterministic synth key so
  // idempotency never rests on a nullable column, and a real arrival is never
  // rejected merely for lacking the header.
  let messageId = headerValue(headers, 'Message-ID') ?? headerValue(headers, 'Message-Id')
  if (messageId) {
    messageId = messageId.trim()
  } else {
    const basis = `${recipient}\n${(dateHeader ?? '').trim()}\n${(subject ?? '').trim()}`
    messageId = `synth:${await sha256Hex(basis)}`
  }

  const sequence = Number.parseInt(recipient.slice(3, recipient.indexOf('@')), 10)
  const keepBody = Number.isFinite(sequence) && sequence >= 1 && sequence <= inspectableCount

  const row: Record<string, unknown> = {
    recipient_email: recipient,
    received_at: receivedAtFromHeaders(headers) ?? new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    message_id: messageId,
    subject,
    headers_meta: {
      date: dateHeader,
      received_count: (headers.match(/^Received:/gim) ?? []).length,
      list_unsubscribe: headerValue(headers, 'List-Unsubscribe'),
      list_unsubscribe_post: headerValue(headers, 'List-Unsubscribe-Post'),
      auth: parseAuthResults(headers),
    },
    body_html: keepBody ? ((form.get('html') as string | null) ?? (form.get('text') as string | null)) : null,
  }

  const { error } = await supabase
    .from('send_test_arrivals')
    .upsert(row, { onConflict: 'recipient_email,message_id' })

  if (error) {
    // 5xx so SendGrid retries. A lost arrival reads as a pipeline failure in the
    // completion metric, which is exactly the wrong thing to be wrong about.
    console.error('[send-test-inbound] insert failed', error.message)
    return new Response('Storage error', { status: 503, headers: corsHeaders })
  }

  return new Response('ok', { status: 200, headers: corsHeaders })
}

// IMPORTANT: both wirings are required. Deno.serve is what registers the
// request listener with the Edge Runtime — without it the function deploys
// cleanly but every cold start hangs until the 30s timeout.
export default handler
Deno.serve(handler)
