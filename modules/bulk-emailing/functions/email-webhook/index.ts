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

async function findLogByMessageId(messageId: string) {
  const { data } = await supabase
    .from('email_send_log')
    .select('id, recipient_email, delivered_at, first_opened_at, first_clicked_at')
    .eq('provider_message_id', messageId)
    .single()
  return data
}

async function processNormalizedEvent(event: NormalizedEmailEvent) {
  const log = await findLogByMessageId(event.messageId)
  if (!log) {
    console.warn(`[email-webhook] No log found for message ID: ${event.messageId}`)
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
      break
  }

  if (Object.keys(updates).length > 0) {
    await supabase.from('email_send_log').update(updates).eq('id', log.id)
  }

  // Create interaction records for open/click events
  if (event.eventType !== 'open' && event.eventType !== 'click') return

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

    // Also check other emails to this recipient
    const { count: humanOpenCount } = await supabase
      .from('email_interactions')
      .select('*', { count: 'exact', head: true })
      .eq('event_type', 'open')
      .eq('is_bot', false)
      .in('email_send_log_id',
        supabase.from('email_send_log').select('id').eq('recipient_email', log.recipient_email)
      )

    const { count: humanClickCount } = await supabase
      .from('email_interactions')
      .select('*', { count: 'exact', head: true })
      .eq('event_type', 'click')
      .eq('is_bot', false)
      .in('email_send_log_id',
        supabase.from('email_send_log').select('id').eq('recipient_email', log.recipient_email)
      )

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

export default async function(req: Request) {
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
