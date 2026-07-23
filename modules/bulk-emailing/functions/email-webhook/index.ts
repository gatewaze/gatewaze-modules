import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getEmailProvider } from '../_shared/provider-registry.ts'
import { getBotDetector } from '../_shared/bot-detector-registry.ts'
import type { NormalizedEmailEvent } from '../_shared/email-provider.ts'
import type { InteractionContext } from '../_shared/bot-detector.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function findLogByMessageId(messageId: string, recipientEmail?: string) {
  // Prefer the (provider_message_id, recipient_email) composite when the
  // provider gave us the recipient — that's the natural per-email key and
  // disambiguates batch-send rows where one SendGrid message_id covers
  // multiple recipients. `.maybeSingle()` returns null cleanly when nothing
  // matches (vs `.single()` which errors), so we can fall back to the bare
  // messageId path for providers / legacy events without `email`.
  if (recipientEmail) {
    const composite = await supabase
      .from('email_send_log')
      .select('id, recipient_email, delivered_at, first_opened_at, first_clicked_at')
      .eq('provider_message_id', messageId)
      .eq('recipient_email', recipientEmail)
      .maybeSingle()
    if (composite.data) return composite.data
    // Fall through if not found — historical rows may have a different
    // recipient_email casing than what the provider event carries.
  }
  const { data } = await supabase
    .from('email_send_log')
    .select('id, recipient_email, delivered_at, first_opened_at, first_clicked_at')
    .eq('provider_message_id', messageId)
    .maybeSingle()
  return data
}

interface NewsletterLinkResolution {
  edition_link_id: string
  block_id: string | null
  block_type: string | null
  edition_id: string | null
}

/** Extract the `nlb` tracking key from a clicked URL (last value wins). */
function parseNlb(url: string): string | null {
  const qIdx = url.indexOf('?')
  if (qIdx < 0) return null
  const hashIdx = url.indexOf('#', qIdx)
  const query = url.slice(qIdx + 1, hashIdx >= 0 ? hashIdx : undefined)
  let key: string | null = null
  for (const part of query.split('&')) {
    const m = /^nlb=(.*)$/i.exec(part)
    if (m) {
      try { key = decodeURIComponent(m[1]) } catch { key = m[1] }
    }
  }
  return key && key.length > 0 ? key : null
}

/** Look up the newsletter link registry by tracking key. NULL if not found or
 *  the newsletters module isn't installed (table absent). */
async function resolveNewsletterLink(trackingKey: string): Promise<NewsletterLinkResolution | null> {
  try {
    const { data } = await supabase
      .from('newsletters_edition_links')
      .select('id, block_id, block_type, edition_id')
      .eq('tracking_key', trackingKey)
      .maybeSingle()
    if (!data) return null
    const r = data as { id: string; block_id: string | null; block_type: string | null; edition_id: string | null }
    return { edition_link_id: r.id, block_id: r.block_id, block_type: r.block_type, edition_id: r.edition_id }
  } catch {
    return null
  }
}

interface BroadcastLinkResolution {
  block_id: string | null
  block_type: string | null
}

/** Look up the broadcast link registry by tracking key — the fallback when the
 *  newsletter lookup misses (both domains share the ?nlb= scheme). NULL if not
 *  found or the broadcasts module isn't installed (table absent). Attribution
 *  to a broadcast is transitive via email_send_log.broadcast_send_id, so only
 *  block_id/block_type (the generic email_interactions columns) are written. */
async function resolveBroadcastLink(trackingKey: string): Promise<BroadcastLinkResolution | null> {
  try {
    const { data } = await supabase
      .from('broadcast_links')
      .select('block_id, block_type')
      .eq('tracking_key', trackingKey)
      .maybeSingle()
    if (!data) return null
    const r = data as { block_id: string | null; block_type: string | null }
    return { block_id: r.block_id, block_type: r.block_type }
  } catch {
    return null
  }
}

/** Personalization-consent check at ingest (opt-in model). Returns true only
 *  when the recipient has affirmatively consented to individual-level tracking;
 *  only then may reporting attribute the event to the person. Defaults to false
 *  (no consent → aggregate-only). */
async function hasPersonalizationConsent(email: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('people')
      .select('attributes')
      .eq('email', email)
      .maybeSingle()
    const attrs = (data as { attributes?: Record<string, unknown> } | null)?.attributes ?? {}
    return attrs.personalization_consent === true
  } catch {
    return false
  }
}

async function processNormalizedEvent(event: NormalizedEmailEvent) {
  const log = await findLogByMessageId(event.messageId, event.recipientEmail)
  if (!log) {
    console.warn(`[email-webhook] No log found for message ID: ${event.messageId}${event.recipientEmail ? ` (recipient ${event.recipientEmail})` : ''}`)
    return
  }

  // Update lifecycle timestamps on email_send_log (idempotent — first occurrence only)
  const updates: Record<string, unknown> = {}

  switch (event.eventType) {
    case 'delivered':
      if (!log.delivered_at) {
        updates.delivered_at = event.timestamp.toISOString()
        updates.status = 'delivered'
      }
      break
    case 'bounced':
      updates.bounced_at = event.timestamp.toISOString()
      updates.status = 'bounced'
      if (event.bounceType) updates.bounce_type = event.bounceType
      if (event.bounceReason) updates.bounce_reason = event.bounceReason
      break
    case 'dropped':
      updates.dropped_at = event.timestamp.toISOString()
      updates.status = 'dropped'
      if (event.bounceReason) updates.bounce_reason = event.bounceReason
      break
    case 'deferred':
      // Deferred = recipient mail server gave a 4xx temporary reject
      // (greylisting, Yahoo throttling, per-domain rate-limits). SendGrid
      // retries internally for ~72h; this row may still resolve to
      // delivered OR bounced. Record the first-defer time and flip status
      // ONLY if not already terminal — webhook events can arrive out of
      // order, so a later-arriving defer must never demote a confirmed
      // delivery/bounce/drop/spam_report.
      if (!log.deferred_at) {
        updates.deferred_at = event.timestamp.toISOString()
      }
      if (!['delivered', 'bounced', 'dropped', 'spam_reported'].includes(log.status)) {
        updates.status = 'deferred'
      }
      if (event.bounceReason) updates.bounce_reason = event.bounceReason
      break
    case 'spam_reported':
      updates.spam_reported_at = event.timestamp.toISOString()
      updates.status = 'spam_reported'
      break
    case 'open':
      if (!log.first_opened_at) {
        updates.first_opened_at = event.timestamp.toISOString()
      }
      break
    case 'click':
      if (!log.first_clicked_at) {
        updates.first_clicked_at = event.timestamp.toISOString()
      }
      // Recover opens from click signal: SendGrid's open tracking depends on
      // a 1x1 pixel image fetch, which Apple Mail Privacy Protection /
      // Gmail's image proxy / plain-text readers all suppress — so genuine
      // human opens go silent for those recipients. A click can't happen
      // without the recipient having rendered the email body, so the click
      // timestamp is a strictly-conservative lower bound on the open time.
      // Backfill first_opened_at to the click timestamp when no real open
      // event has landed yet. Idempotent (only sets when null).
      if (!log.first_opened_at) {
        updates.first_opened_at = event.timestamp.toISOString()
      }
      break
  }

  if (Object.keys(updates).length > 0) {
    await supabase.from('email_send_log').update(updates).eq('id', log.id)
  }

  // Create interaction records for open/click events
  if (event.eventType !== 'open' && event.eventType !== 'click') return

  // Resolve newsletter block from the ?nlb= tracking key (clicks only), and
  // make the consent decision at ingest. See spec-newsletter-link-tracking.md
  // §4.4 / §7. Both are best-effort: failures leave NULL/false, never blocking.
  let resolved: NewsletterLinkResolution | null = null
  let broadcastResolved: BroadcastLinkResolution | null = null
  if (event.eventType === 'click' && event.clickedUrl) {
    const nlb = parseNlb(event.clickedUrl)
    if (nlb) {
      resolved = await resolveNewsletterLink(nlb)
      // Same ?nlb= scheme serves broadcasts; fall back to the broadcast
      // registry when the newsletter lookup misses (module may be absent).
      if (!resolved) {
        broadcastResolved = await resolveBroadcastLink(nlb)
      }
      if (!resolved && !broadcastResolved) {
        console.warn(`[email-webhook] unresolved nlb '${nlb}' on click: ${event.clickedUrl}`)
      }
    }
  }
  const personalizationConsent = await hasPersonalizationConsent(log.recipient_email)

  // Insert raw interaction (default human_confidence = 1.0)
  const { data: interaction } = await supabase.from('email_interactions').insert({
    email_send_log_id: log.id,
    event_type: event.eventType,
    event_timestamp: event.timestamp.toISOString(),
    clicked_url: event.clickedUrl || null,
    user_agent: event.userAgent || null,
    ip_address: event.ip || null,
    human_confidence: 1.0,
    bot_signals: [],
    edition_link_id: resolved?.edition_link_id ?? null,
    block_id: resolved?.block_id ?? broadcastResolved?.block_id ?? null,
    block_type: resolved?.block_type ?? broadcastResolved?.block_type ?? null,
    edition_id: resolved?.edition_id ?? null,
    personalization_consent: personalizationConsent,
  }).select('id').single()

  if (!interaction) return

  // Score with bot detector if installed
  const detector = await getBotDetector(supabase)
  if (!detector) return

  try {
    // Fetch recent interactions for pattern detection
    const { data: recentInteractions } = await supabase
      .from('email_interactions')
      .select('event_type, event_timestamp, clicked_url, user_agent, ip_address')
      .eq('email_send_log_id', log.id)
      .neq('id', interaction.id)
      .order('event_timestamp', { ascending: false })
      .limit(20)

    // Fetch recipient engagement history
    const { data: historyData } = await supabase
      .from('email_interactions')
      .select('event_type, is_bot')
      .eq('email_send_log_id', log.id)
      .eq('is_bot', false)

    // Cross-edition engagement signal for this recipient: how many other
    // emails to the same address have a confirmed human open/click? The
    // earlier shape used `.in(col, supabase.from(...).select(...))` —
    // supabase-js v2's `.in()` ONLY accepts arrays, so that variant threw
    // (caught silently in the outer try/catch) and was the actual root
    // cause of 0/27,985 events scoring on AAIF prod 2026-06-23. Materialise
    // the send_log ids first; cap the prior-history fan-out at 200 so this
    // stays bounded for very chatty recipients.
    const { data: priorLogs } = await supabase
      .from('email_send_log')
      .select('id')
      .eq('recipient_email', log.recipient_email)
      .neq('id', log.id)
      .order('sent_at', { ascending: false, nullsFirst: false })
      .limit(200)

    const priorLogIds = (priorLogs ?? []).map((r: { id: string }) => r.id)

    let humanOpenCount = 0
    let humanClickCount = 0
    if (priorLogIds.length > 0) {
      const { count: openCount } = await supabase
        .from('email_interactions')
        .select('*', { count: 'exact', head: true })
        .eq('event_type', 'open')
        .eq('is_bot', false)
        .in('email_send_log_id', priorLogIds)
      humanOpenCount = openCount ?? 0

      const { count: clickCount } = await supabase
        .from('email_interactions')
        .select('*', { count: 'exact', head: true })
        .eq('event_type', 'click')
        .eq('is_bot', false)
        .in('email_send_log_id', priorLogIds)
      humanClickCount = clickCount ?? 0
    }

    const context: InteractionContext = {
      eventType: event.eventType as 'open' | 'click',
      eventTimestamp: event.timestamp,
      deliveredAt: log.delivered_at ? new Date(log.delivered_at) : null,
      userAgent: event.userAgent || null,
      ip: event.ip || null,
      clickedUrl: event.clickedUrl || null,
      recipientEmail: log.recipient_email,
      recentInteractions: (recentInteractions || []).map((i: any) => ({
        event_type: i.event_type,
        event_timestamp: new Date(i.event_timestamp),
        clicked_url: i.clicked_url,
        user_agent: i.user_agent,
        ip_address: i.ip_address,
      })),
      recipientHistory: {
        humanOpenCount: humanOpenCount || 0,
        humanClickCount: humanClickCount || 0,
      },
    }

    const result = await detector.score(context)

    // Update the interaction with bot scoring
    await supabase.from('email_interactions').update({
      human_confidence: result.humanConfidence,
      bot_signals: result.signals,
      scorer_id: result.scorerId,
      scored_at: new Date().toISOString(),
    }).eq('id', interaction.id)

    // Also store in comparison table
    await supabase.from('email_interaction_scores').upsert({
      interaction_id: interaction.id,
      scorer_id: result.scorerId,
      human_confidence: result.humanConfidence,
      signals: result.signals,
      scored_at: new Date().toISOString(),
    }, { onConflict: 'interaction_id,scorer_id' })

  } catch (err) {
    console.error('[email-webhook] Bot scoring failed, interaction saved without score:', err)
  }
}

async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const provider = await getEmailProvider(supabase)

    // Verify webhook authenticity
    if (!await provider.verifyWebhook(req)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Parse into normalized events
    const events = await provider.parseWebhookPayload(req)
    if (!events || events.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    let processed = 0
    let errors = 0

    for (const event of events) {
      try {
        await processNormalizedEvent(event)
        processed++
      } catch (err) {
        errors++
        console.error(`[email-webhook] Error processing event for ${event.messageId}:`, err)
      }
    }

    return new Response(JSON.stringify({ processed, errors }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error: any) {
    console.error('email-webhook error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
}

// IMPORTANT: every Supabase Edge Function in this repo wires the handler via
// BOTH `export default handler;` AND `Deno.serve(handler);`. The Deno.serve
// call is what actually registers the request listener with the Edge Runtime.
// Without it the function deploys cleanly but cold starts hang forever — every
// inbound request times out at 30s with HTTP 000, which is exactly how the
// email-webhook function manifested before this fix. See newsletter-send /
// email-sendgrid-webhook for the same pattern.
export default handler;
Deno.serve(handler);
