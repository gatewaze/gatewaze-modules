import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'
import { getEmailProvider } from '../_shared/provider-registry.ts'
import type { EmailProviderModule } from '../_shared/email-provider.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = ReturnType<typeof createClient<any, any, any>>

/**
 * Broadcast Send Edge Function
 *
 * Test-send-only entrypoint for broadcasts. The scheduled-dispatch path used
 * to live here (POST { process_scheduled: true }) but has moved into the Node
 * worker's broadcasts:dispatch-scheduled cron, which now calls
 * fanout_broadcast_send_recipients directly and runs the drip in-process — no
 * Edge round-trip. The send_id immediate-send path is similarly unused (the
 * shared SendingPanel routes immediate sends through scheduled_at=now via the
 * same worker cron); the branch is kept for backwards compatibility but no
 * caller in-tree exercises it.
 *
 * Remaining triggers (single-recipient operator tests — no fan-out/drip):
 *  - POST { test_send: { send_id, email } }      → test against an existing send
 *      instance.
 *  - POST { test_send: { broadcast_id, email } } → test from the broadcast PARENT
 *      before any send instance exists (shared SendingPanel test button).
 *
 * The test path uses the Deno-side provider directly because the worker engine
 * has no single-recipient entry point.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// If the segment was recalculated within this window we skip the recalc before
// fan-out (avoids a redundant full recompute on every send). spec §1.2.
const SEGMENT_FRESHNESS_MS = 60 * 60 * 1000

// Recipient merge fields usable in content as {{field}} or {{field|fallback}}.
const MERGE_FIELDS = ['first_name', 'last_name', 'name', 'company', 'job_title'] as const
const MERGE_FIELD_GROUP = MERGE_FIELDS.join('|')

function htmlUsesMergeFields(html: string): boolean {
  return new RegExp(`\\{\\{\\s*(?:${MERGE_FIELD_GROUP})\\b`).test(html)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function unquoteFallback(fb: string): string {
  const t = fb.trim()
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

function substituteMergeFields(text: string, attrs: Record<string, unknown>, escape = true): string {
  const re = new RegExp(`\\{\\{\\s*(${MERGE_FIELD_GROUP})\\s*(?:\\|([^}]*))?\\}\\}`, 'g')
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
  return text.replace(re, (_m, field: string, fallback?: string) => {
    let val: string
    if (field === 'name') {
      val = [str(attrs.first_name), str(attrs.last_name)].filter(Boolean).join(' ')
    } else {
      val = str(attrs[field])
    }
    if (!val) val = unquoteFallback(fallback ?? '')
    return escape ? escapeHtml(val) : val
  })
}

// HMAC unsubscribe token encoding (email, suppression_topic). Mirrors the
// newsletter token shape but the second segment is the TOPIC, not a list id —
// a broadcast unsubscribe suppresses a topic, not a list (spec §1.5).
async function generateUnsubscribeToken(email: string, topic: string, hmacSecret: string): Promise<string> {
  const timestamp = Date.now()
  const payload = `${email}:${topic}:${timestamp}`
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(hmacSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  const sigStr = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const encodedPayload = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encodedPayload}.${sigStr}`
}

interface SendContext {
  html: string
  subject: string
  topic: string
  fromEmail: string
  fromName: string
  replyTo: string | null
  hmacSecret: string | undefined
  supabaseUrl: string
  portalBaseUrl: string | null
  usesMergeFields: boolean
  attrsByEmail: Map<string, Record<string, unknown>>
}

function buildSendContext(send: any): SendContext {
  const html = send.rendered_html as string
  if (!html) throw new Error('No rendered HTML found. Compose the broadcast first.')
  const subject = send.subject || 'Message'
  return {
    html,
    subject,
    topic: send.suppression_topic || 'broadcasts',
    fromEmail: send.from_address || Deno.env.get('BULK_EMAIL_FROM_ADDRESS') || Deno.env.get('EMAIL_FROM') || 'noreply@localhost',
    fromName: send.from_name || Deno.env.get('BULK_EMAIL_FROM_NAME') || Deno.env.get('EMAIL_FROM_NAME') || 'Gatewaze',
    replyTo: send.reply_to || null,
    hmacSecret: Deno.env.get('UNSUBSCRIBE_HMAC_SECRET'),
    supabaseUrl: Deno.env.get('SUPABASE_URL')!,
    portalBaseUrl: ((send.metadata as { portal_base_url?: string } | null)?.portal_base_url) || Deno.env.get('SITE_URL') || null,
    usesMergeFields: htmlUsesMergeFields(html) || htmlUsesMergeFields(subject),
    attrsByEmail: new Map(),
  }
}

async function loadRecipientAttributes(supabase: SB, emails: string[], ctx: SendContext): Promise<void> {
  if (!ctx.usesMergeFields) return
  const CHUNK = 500
  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK)
    const { data: rows, error } = await supabase.from('people').select('email, attributes').in('email', chunk)
    if (error) { console.warn('[broadcast-send] people lookup failed:', error.message); break }
    for (const row of rows ?? []) {
      ctx.attrsByEmail.set((row as { email: string }).email, (row as { attributes?: Record<string, unknown> }).attributes ?? {})
    }
  }
}

/** Send to one recipient: topic unsubscribe header + footer, merge fields,
 *  email_send_log row (attributed to broadcast_send_id), provider call. Returns
 *  true on success; never throws. */
async function sendToRecipient(supabase: SB, provider: EmailProviderModule, ctx: SendContext, sendId: string | null, email: string): Promise<boolean> {
  try {
    let oneClickUrl = ''
    let unsubUrl = ''
    let manageUrl = ''
    let emailHeaders: Record<string, string> = {}
    if (ctx.hmacSecret) {
      const token = await generateUnsubscribeToken(email, ctx.topic, ctx.hmacSecret)
      const tok = encodeURIComponent(token)
      oneClickUrl = `${ctx.supabaseUrl}/functions/v1/broadcast-unsubscribe?token=${tok}`
      const base = ctx.portalBaseUrl ? ctx.portalBaseUrl.replace(/\/$/, '') : null
      manageUrl = base ? `${base}/subscriptions?token=${tok}` : oneClickUrl
      unsubUrl = base ? `${base}/subscriptions?token=${tok}&unsub=1` : oneClickUrl
      emailHeaders = {
        'List-Unsubscribe': `<${oneClickUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }
    }

    let personalizedHtml = ctx.html
    if (unsubUrl) {
      const hadPlaceholder = /\{\{unsubscribe_url\}\}/.test(ctx.html)
      personalizedHtml = personalizedHtml
        .replace(/\{\{unsubscribe_url\}\}/g, unsubUrl)
        .replace(/\{\{manage_subscriptions_url\}\}/g, manageUrl)
      if (!hadPlaceholder) {
        const footer =
          `<div style="text-align:center;padding:20px;font-size:12px;color:#999;">` +
          `<a href="${unsubUrl}" style="color:#999;">Unsubscribe</a> &middot; ` +
          `<a href="${manageUrl}" style="color:#999;">Manage your email preferences</a></div>`
        personalizedHtml = /<\/body>/i.test(personalizedHtml)
          ? personalizedHtml.replace(/<\/body>/i, `${footer}</body>`)
          : personalizedHtml + footer
      }
    }

    let subject = ctx.subject
    if (ctx.usesMergeFields) {
      const attrs = ctx.attrsByEmail.get(email) ?? {}
      personalizedHtml = substituteMergeFields(personalizedHtml, attrs, true)
      subject = substituteMergeFields(ctx.subject, attrs, false)
    }

    const { data: logEntry } = await supabase.from('email_send_log').insert({
      recipient_email: email,
      from_address: ctx.fromEmail,
      reply_to: ctx.replyTo,
      subject,
      content_html: personalizedHtml,
      provider: provider.name,
      broadcast_send_id: sendId,
      status: 'queued',
      queued_at: new Date().toISOString(),
    }).select('id').single()

    const result = await provider.send({
      to: email,
      from: ctx.fromEmail,
      fromName: ctx.fromName,
      ...(ctx.replyTo ? { replyTo: ctx.replyTo } : {}),
      subject,
      html: personalizedHtml,
      headers: emailHeaders,
      disableSubscriptionTracking: true,
    })

    if (result.success) {
      await supabase.from('email_send_log').update({
        status: 'sent', sent_at: new Date().toISOString(), provider_message_id: result.messageId || null, send_attempts: 1,
      }).eq('id', logEntry?.id)
      return true
    }
    await supabase.from('email_send_log').update({
      status: result.retryable ? 'send_failed' : 'permanently_failed', failure_error: result.error, send_attempts: 1,
    }).eq('id', logEntry?.id)
    return false
  } catch (err) {
    console.error('[broadcast-send] recipient failed:', email, err instanceof Error ? err.message : err)
    return false
  }
}

/** Best-effort segment recalculation before fan-out, so the materialised
 *  audience reflects the current definition (spec §1.2). Tolerant of failure
 *  (e.g. admin-gated RPC in a service context) — falls back to existing
 *  membership and logs. */
async function maybeRecalcSegment(supabase: SB, send: any): Promise<void> {
  if (send.audience_type !== 'segment' || !send.segment_id) return
  try {
    const { data: seg } = await supabase
      .from('segments')
      .select('last_calculated_at')
      .eq('id', send.segment_id)
      .maybeSingle()
    const last = (seg as { last_calculated_at?: string } | null)?.last_calculated_at
    if (last && Date.now() - new Date(last).getTime() < SEGMENT_FRESHNESS_MS) return
    const { error } = await supabase.rpc('segments_calculate_members', { p_segment_id: send.segment_id })
    if (error) console.warn('[broadcast-send] segment recalc skipped:', error.message)
  } catch (err) {
    console.warn('[broadcast-send] segment recalc error:', err instanceof Error ? err.message : err)
  }
}

/** Fan out a broadcast into the per-recipient timing queue and flip to 'sending'. */
async function fanOutAndStart(supabase: SB, sendId: string): Promise<{ success: boolean; error?: string }> {
  const { data: send } = await supabase.from('broadcast_sends').select('*').eq('id', sendId).single()
  if (!send) return { success: false, error: 'Broadcast not found' }
  if (!send.rendered_html) {
    await supabase.from('broadcast_sends').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', sendId)
    return { success: false, error: 'No rendered HTML' }
  }
  await maybeRecalcSegment(supabase, send)
  const { error } = await supabase.rpc('fanout_broadcast_send_recipients', { p_send_id: sendId })
  if (error) {
    await supabase.from('broadcast_sends').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', sendId)
    return { success: false, error: error.message }
  }
  // Empty audience after suppression filtering → terminal failure with a clear reason.
  const { count } = await supabase.from('broadcast_send_recipients').select('id', { count: 'exact', head: true }).eq('send_id', sendId)
  if ((count ?? 0) === 0) {
    await supabase.from('broadcast_sends').update({
      status: 'failed', completed_at: new Date().toISOString(),
      metadata: { ...(send.metadata || {}), error: '0 deliverable recipients after suppression filtering' },
      updated_at: new Date().toISOString(),
    }).eq('id', sendId)
    return { success: false, error: '0 deliverable recipients' }
  }
  await supabase.from('broadcast_sends').update({
    status: 'sending', started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', sendId)
  return { success: true }
}

/** Single-recipient test send through the same rendering path (no fan-out/drip). */
async function processTestSend(supabase: SB, provider: EmailProviderModule, sendId: string, email: string): Promise<{ success: boolean; error?: string }> {
  const { data: send } = await supabase.from('broadcast_sends').select('*').eq('id', sendId).single()
  if (!send) return { success: false, error: 'Broadcast not found' }
  let ctx: SendContext
  try { ctx = buildSendContext(send) } catch (err) { return { success: false, error: err instanceof Error ? err.message : 'context build failed' } }
  ctx.subject = `[TEST] ${ctx.subject}`
  await loadRecipientAttributes(supabase, [email], ctx)
  const ok = await sendToRecipient(supabase, provider, ctx, sendId, email)
  return ok ? { success: true } : { success: false, error: 'Provider send failed' }
}

// Test from the broadcast PARENT (no send instance yet) — the shared SendingPanel
// offers a test before any send is created. buildSendContext reads the same
// content columns the parent carries; the email_send_log row is unattributed
// (broadcast_send_id is null) since there's no send instance.
async function processTestSendFromParent(supabase: SB, provider: EmailProviderModule, broadcastId: string, email: string): Promise<{ success: boolean; error?: string }> {
  const { data: parent } = await supabase.from('broadcasts').select('*').eq('id', broadcastId).single()
  if (!parent) return { success: false, error: 'Broadcast not found' }
  let ctx: SendContext
  try { ctx = buildSendContext(parent) } catch (err) { return { success: false, error: err instanceof Error ? err.message : 'context build failed' } }
  ctx.subject = `[TEST] ${ctx.subject}`
  await loadRecipientAttributes(supabase, [email], ctx)
  const ok = await sendToRecipient(supabase, provider, ctx, null, email)
  return ok ? { success: true } : { success: false, error: 'Provider send failed' }
}

async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  let provider: EmailProviderModule
  try {
    provider = await getEmailProvider(supabase)
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: 'Email provider not configured: ' + (err instanceof Error ? err.message : 'Unknown') }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  try {
    const body = await req.json()
    if (body.test_send?.send_id && body.test_send?.email) {
      const result = await processTestSend(supabase, provider, body.test_send.send_id, body.test_send.email)
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    if (body.test_send?.broadcast_id && body.test_send?.email) {
      const result = await processTestSendFromParent(supabase, provider, body.test_send.broadcast_id, body.test_send.email)
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    if (body.send_id) {
      // Worker owns the drip — the Edge only fans out + flips to 'sending'.
      // Kept for backwards compatibility; the shared SendingPanel routes
      // immediate sends through scheduled_at=now() instead, so no in-tree
      // caller currently exercises this branch.
      const result = await fanOutAndStart(supabase, body.send_id)
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ success: false, error: 'Must provide send_id or test_send' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error) {
    console.error('Broadcast send error:', error)
    return new Response(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Internal error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
}

export default handler
Deno.serve(handler)
