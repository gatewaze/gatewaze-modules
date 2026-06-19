import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

/**
 * Broadcast Unsubscribe Edge Function
 *
 * Honours the RFC 8058 one-click `List-Unsubscribe` header and the visible
 * footer link emitted by broadcast-send. The token encodes (email, topic); we
 * verify the HMAC and write a broadcast_suppressions row for that (email, topic)
 * so all future fan-outs exclude this recipient (spec §1.5).
 *
 * POST (one-click) → suppress + 200.
 * GET (link click) → suppress + a tiny confirmation page.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
}

async function verifyToken(token: string, hmacSecret: string): Promise<{ email: string; topic: string } | null> {
  const [encodedPayload, sig] = token.split('.')
  if (!encodedPayload || !sig) return null
  let payload: string
  try { payload = b64urlDecode(encodedPayload) } catch { return null }
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(hmacSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const expected = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  const expectedStr = btoa(String.fromCharCode(...new Uint8Array(expected))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  if (expectedStr !== sig) return null
  // payload = email:topic:timestamp
  const parts = payload.split(':')
  if (parts.length < 3) return null
  const email = parts[0]
  const topic = parts[1]
  if (!email || !topic) return null
  return { email, topic }
}

async function suppress(supabase: ReturnType<typeof createClient>, email: string, topic: string): Promise<void> {
  await supabase.from('broadcast_suppressions').upsert(
    { email, topic, source: 'one_click_unsubscribe', reason: 'recipient unsubscribed' },
    { onConflict: 'email,topic', ignoreDuplicates: true },
  )
}

async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const url = new URL(req.url)
  const token = url.searchParams.get('token') || ''
  const hmacSecret = Deno.env.get('UNSUBSCRIBE_HMAC_SECRET')
  if (!hmacSecret) {
    return new Response(JSON.stringify({ success: false, error: 'Unsubscribe not configured' }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
  if (!token) {
    return new Response(JSON.stringify({ success: false, error: 'Missing token' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const verified = await verifyToken(token, hmacSecret)
  if (!verified) {
    return new Response(JSON.stringify({ success: false, error: 'Invalid token' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  await suppress(supabase, verified.email, verified.topic)

  // One-click POST (RFC 8058): machine endpoint, return 200.
  if (req.method === 'POST') {
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
  // GET: human-facing confirmation.
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribed</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;text-align:center;color:#333;">` +
    `<h1 style="font-size:20px;">You've been unsubscribed</h1>` +
    `<p style="color:#666;">${escapeHtmlText(verified.email)} will no longer receive “${escapeHtmlText(verified.topic)}” messages.</p>` +
    `</body></html>`
  return new Response(page, { status: 200, headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' } })
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export default handler
Deno.serve(handler)
