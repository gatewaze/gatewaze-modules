import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'
import { getEmailProvider } from '../_shared/provider-registry.ts'
import type { EmailProviderModule } from '../_shared/email-provider.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = ReturnType<typeof createClient<any, any, any>>

/**
 * Broadcast Send Edge Function
 *
 * Sends a single broadcast (one message → a segment or contact list) with the
 * same per-recipient-timezone drip the newsletters module uses. The audience
 * SOURCE is a segment (segments_memberships) rather than an edition + list, and
 * suppression/unsubscribe is topic-scoped (broadcast_suppressions) rather than
 * per-list. Everything else mirrors newsletter-send.
 *
 * Triggers:
 *  - POST { process_scheduled: true }  → cron heartbeat: fan out due scheduled
 *      broadcasts + run one drip pass (the BullMQ stand-in for pg_cron).
 *  - POST { send_id }                  → fan out + start a broadcast immediately.
 *  - POST { test_send: { send_id, email } } → single-recipient test, same
 *      rendering path, bypassing fan-out + drip.
 *
 * NOTE (Phase 0 / Tier 2): this runs on the proven Edge-Function drip path
 * (per-recipient provider.send, batched). When the Tier 2 worker-side
 * `sendBatch` engine lands, broadcasts migrate onto it via the shared binding;
 * the tables + RPCs here are deliberately newsletter-shaped to make that fold-in
 * mechanical. See spec-broadcasts-module.md Phase 0.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const BATCH_SIZE = 50
const BATCH_DELAY_MS = 1000
const DRIP_LIMIT = 200
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
async function sendToRecipient(supabase: SB, provider: EmailProviderModule, ctx: SendContext, sendId: string, email: string): Promise<boolean> {
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

async function recomputeAndMaybeFinalize(supabase: SB, sendId: string, forceCancel = false): Promise<void> {
  const headCount = async (statuses: string[]): Promise<number> => {
    const { count } = await supabase.from('broadcast_send_recipients').select('id', { count: 'exact', head: true }).eq('send_id', sendId).in('status', statuses)
    return count ?? 0
  }
  const [remaining, sent, failed] = await Promise.all([
    headCount(['pending', 'sending']), headCount(['sent']), headCount(['failed']),
  ])
  const patch: Record<string, unknown> = { sent_count: sent, failed_count: failed, updated_at: new Date().toISOString() }
  if (remaining === 0) {
    patch.status = forceCancel ? 'cancelled' : (sent === 0 && failed > 0 ? 'failed' : 'sent')
    patch.completed_at = new Date().toISOString()
  }
  await supabase.from('broadcast_sends').update(patch).eq('id', sendId)
}

/** One drip pass across all 'sending' broadcasts. */
async function runRecipientDrip(supabase: SB, provider: EmailProviderModule): Promise<void> {
  const { data: claimed, error } = await supabase.rpc('claim_due_broadcast_recipients', { p_limit: DRIP_LIMIT })
  if (error) console.error('[broadcast-drip] claim failed:', error.message)

  const bySend = new Map<string, Array<{ id: string; email: string }>>()
  for (const r of claimed ?? []) {
    if (!bySend.has(r.send_id)) bySend.set(r.send_id, [])
    bySend.get(r.send_id)!.push({ id: r.id, email: r.email })
  }

  for (const [sendId, recips] of bySend) {
    const { data: send } = await supabase.from('broadcast_sends').select('*').eq('id', sendId).single()
    if (!send) continue
    if (send.status === 'cancelling' || send.status === 'cancelled') {
      await supabase.from('broadcast_send_recipients').update({ status: 'skipped', updated_at: new Date().toISOString() }).in('id', recips.map((r) => r.id))
      continue
    }
    let ctx: SendContext
    try {
      ctx = buildSendContext(send)
    } catch (err) {
      await supabase.from('broadcast_send_recipients')
        .update({ status: 'pending', last_error: err instanceof Error ? err.message : 'context build failed', updated_at: new Date().toISOString() })
        .in('id', recips.map((r) => r.id))
      continue
    }
    await loadRecipientAttributes(supabase, recips.map((r) => r.email), ctx)
    for (let i = 0; i < recips.length; i += BATCH_SIZE) {
      const slice = recips.slice(i, i + BATCH_SIZE)
      const results = await Promise.allSettled(
        slice.map((r) => sendToRecipient(supabase, provider, ctx, sendId, r.email).then((ok) => ({ id: r.id, ok }))),
      )
      for (const res of results) {
        if (res.status === 'fulfilled') {
          await supabase.from('broadcast_send_recipients').update({ status: res.value.ok ? 'sent' : 'failed', updated_at: new Date().toISOString() }).eq('id', res.value.id)
        }
      }
      if (i + BATCH_SIZE < recips.length) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
    }
  }

  // Refresh counters + finalise every in-flight broadcast (propagates stops).
  const { data: active } = await supabase.from('broadcast_sends').select('id, status').in('status', ['sending', 'cancelling'])
  for (const s of active ?? []) {
    if (s.status === 'cancelling') {
      await supabase.from('broadcast_send_recipients').update({ status: 'skipped', updated_at: new Date().toISOString() }).eq('send_id', s.id).in('status', ['pending', 'sending'])
      await recomputeAndMaybeFinalize(supabase, s.id, true)
    } else {
      await recomputeAndMaybeFinalize(supabase, s.id)
    }
  }
}

async function processScheduledSends(supabase: SB, provider: EmailProviderModule): Promise<{ success: boolean; processed: number; errors: string[] }> {
  const { data: sends, error } = await supabase
    .from('broadcast_sends')
    .select('id')
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at')
    .limit(10)
  if (error) return { success: false, processed: 0, errors: [error.message] }

  const errors: string[] = []
  let processed = 0
  for (const send of sends || []) {
    const r = await fanOutAndStart(supabase, send.id)
    if (r.success) processed++
    else errors.push(`Broadcast ${send.id}: ${r.error}`)
  }
  await runRecipientDrip(supabase, provider)
  return { success: true, processed, errors }
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
    if (body.send_id) {
      const result = await fanOutAndStart(supabase, body.send_id)
      if (result.success) await runRecipientDrip(supabase, provider)
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    if (body.process_scheduled) {
      const result = await processScheduledSends(supabase, provider)
      return new Response(JSON.stringify(result), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ success: false, error: 'Must provide send_id, process_scheduled, or test_send' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error) {
    console.error('Broadcast send error:', error)
    return new Response(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Internal error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
}

export default handler
Deno.serve(handler)
