import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'
import { recordUnsubscribe, unsubscribeStatus, unsubscribeStep } from '../_shared/unsubscribe-suppress.ts'

/**
 * Broadcast Unsubscribe Edge Function
 *
 * Honours the RFC 8058 one-click `List-Unsubscribe` header and the visible
 * footer link emitted by broadcast-send. The token encodes (email, topic); we
 * verify the HMAC and write a broadcast_suppressions row for that (email, topic)
 * so all future fan-outs exclude this recipient (spec §1.5).
 *
 * POST (one-click, RFC 8058) → suppress + JSON (500 if nothing was saved).
 * GET (link click) → a confirm button only, since mail scanners open links.
 * POST confirm=1 (that button) → suppress + a result page.
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

  const step = unsubscribeStep(req.method, req.method === 'POST' ? await req.text().catch(() => '') : '')
  if (step.action === 'reject') {
    return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
  if (step.action === 'confirm-page') {
    // Scanners open links, so a GET only asks; the button posts the confirm.
    return html(200, 'Unsubscribe',
      `<h1 style="font-size:20px;">Unsubscribe?</h1>` +
      `<p style="color:#666;">Stop sending “${escapeHtml(verified.topic)}” messages to ${escapeHtml(verified.email)}.</p>` +
      `<form method="post" action="?token=${escapeHtml(encodeURIComponent(token))}">` +
      `<input type="hidden" name="confirm" value="1">` +
      `<button type="submit" style="margin-top:16px;padding:10px 20px;font-size:16px;border-radius:6px;border:0;background:#333;color:#fff;cursor:pointer;">Unsubscribe</button>` +
      `</form>`)
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const saved = await recordUnsubscribe(supabase, verified.email, verified.topic)
  const status = unsubscribeStatus(saved)
  if (!saved.ok) console.error('[broadcast-unsubscribe] suppression write failed:', saved.error)

  if (step.reply === 'json') {
    // RFC 8058 one-click POST from the mail client.
    return new Response(JSON.stringify(saved.ok ? { success: true } : { success: false, error: 'Could not save the unsubscribe' }), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
  // Never tell someone they are unsubscribed when nothing was saved.
  if (!saved.ok) {
    return html(status, 'Unsubscribe failed',
      `<h1 style="font-size:20px;">We could not unsubscribe you</h1>` +
      `<p style="color:#666;">Something went wrong on our side. Please try the link again in a few minutes.</p>`)
  }
  return html(status, 'Unsubscribed',
    `<h1 style="font-size:20px;">You've been unsubscribed</h1>` +
    `<p style="color:#666;">${escapeHtml(verified.email)} will no longer receive “${escapeHtml(verified.topic)}” messages.</p>`)
}

function html(status: number, title: string, body: string): Response {
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;text-align:center;color:#333;">${body}</body></html>`
  return new Response(page, { status, headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' } })
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export default handler
Deno.serve(handler)
