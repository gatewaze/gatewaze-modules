import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'
import { getEmailProvider } from '../_shared/provider-registry.ts'
import type { EmailProviderModule } from '../_shared/email-provider.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * Newsletter Send Edge Function
 *
 * Processes newsletter sends by:
 * 1. Looking up the edition and its rendered HTML
 * 2. Fetching the subscription list recipients
 * 3. Sending individual emails via the email provider interface with unsubscribe headers
 * 4. Logging each email to email_send_log for lifecycle tracking
 * 5. Updating send status and delivery counts
 *
 * Can be triggered by:
 * - Direct POST with { send_id } for immediate sends
 * - pg_cron for scheduled sends (calls with { process_scheduled: true })
 */

const BATCH_SIZE = 50
const BATCH_DELAY_MS = 1000

// ---------------------------------------------------------------------------
// HMAC unsubscribe token generation
// ---------------------------------------------------------------------------

async function generateUnsubscribeToken(
  email: string,
  listId: string,
  hmacSecret: string
): Promise<string> {
  const timestamp = Date.now()
  const payload = `${email}:${listId}:${timestamp}`
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(hmacSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  const sigStr = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  const encodedPayload = btoa(payload)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `${encodedPayload}.${sigStr}`
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ success: false, error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  let provider: EmailProviderModule
  try {
    provider = await getEmailProvider(supabase)
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: 'Email provider not configured: ' + (err instanceof Error ? err.message : 'Unknown') }),
      { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  try {
    const body = await req.json()

    if (body.send_id) {
      const result = await processSend(supabase, body.send_id, provider)
      return new Response(
        JSON.stringify(result),
        { status: result.success ? 200 : 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (body.process_scheduled) {
      const result = await processScheduledSends(supabase, provider)
      return new Response(
        JSON.stringify(result),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ success: false, error: 'Must provide send_id or process_scheduled' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Newsletter send error:', error)
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Internal error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
}

// ---------------------------------------------------------------------------
// Send processing
// ---------------------------------------------------------------------------

async function processScheduledSends(
  supabase: any,
  provider: EmailProviderModule
): Promise<{ success: boolean; processed: number; errors: string[] }> {
  const { data: sends, error } = await supabase
    .from('newsletter_sends')
    .select('id')
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at')
    .limit(10)

  if (error) {
    return { success: false, processed: 0, errors: [error.message] }
  }

  const errors: string[] = []
  let processed = 0

  for (const send of sends || []) {
    const result = await processSend(supabase, send.id, provider)
    if (result.success) {
      processed++
    } else {
      errors.push(`Send ${send.id}: ${result.error}`)
    }
  }

  return { success: true, processed, errors }
}

async function processSend(
  supabase: any,
  sendId: string,
  provider: EmailProviderModule
): Promise<{ success: boolean; delivered: number; failed: number; error?: string }> {
  const { data: send, error: sendError } = await supabase
    .from('newsletter_sends')
    .select('*, edition:newsletters_editions(*)')
    .eq('id', sendId)
    .single()

  if (sendError || !send) {
    return { success: false, delivered: 0, failed: 0, error: 'Send not found' }
  }

  if (!['scheduled', 'draft', 'sending'].includes(send.status)) {
    return { success: false, delivered: 0, failed: 0, error: `Send is in ${send.status} state` }
  }

  await supabase
    .from('newsletter_sends')
    .update({ status: 'sending', updated_at: new Date().toISOString() })
    .eq('id', sendId)

  try {
    const html = send.rendered_html as string
    if (!html) {
      throw new Error('No rendered HTML found. Render the edition first.')
    }

    const subject = send.subject || send.edition?.subject || 'Newsletter'
    const listIds: string[] = send.list_ids || []
    const listId = listIds[0]
    if (!listId) {
      throw new Error('No subscription list configured for this send.')
    }

    const { data: subscribers, error: subError } = await supabase
      .from('list_subscriptions')
      .select('email')
      .eq('list_id', listId)
      .eq('subscribed', true)

    if (subError) throw new Error(`Failed to fetch subscribers: ${subError.message}`)

    const recipientEmails: string[] = (subscribers || []).map((s: any) => s.email)

    await supabase
      .from('newsletter_sends')
      .update({ total_recipients: recipientEmails.length })
      .eq('id', sendId)

    if (recipientEmails.length === 0) {
      await supabase
        .from('newsletter_sends')
        .update({
          status: 'sent',
          completed_at: new Date().toISOString(),
          total_recipients: 0,
          updated_at: new Date().toISOString(),
        })
        .eq('id', sendId)

      return { success: true, delivered: 0, failed: 0 }
    }

    const hmacSecret = Deno.env.get('UNSUBSCRIBE_HMAC_SECRET')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    let delivered = 0
    let failed = 0

    for (let i = 0; i < recipientEmails.length; i += BATCH_SIZE) {
      const batch = recipientEmails.slice(i, i + BATCH_SIZE)

      const fromEmail = send.from_address || Deno.env.get('EMAIL_FROM') || 'noreply@localhost'
      const fromName = send.from_name || Deno.env.get('EMAIL_FROM_NAME') || 'Gatewaze'

      const results = await Promise.allSettled(
        batch.map(async (email: string) => {
          let unsubscribeUrl = ''
          let emailHeaders: Record<string, string> = {}

          if (hmacSecret) {
            const token = await generateUnsubscribeToken(email, listId, hmacSecret)
            unsubscribeUrl = `${supabaseUrl}/functions/v1/newsletter-unsubscribe?token=${encodeURIComponent(token)}`
            emailHeaders = {
              'List-Unsubscribe': `<${unsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            }
          }

          let personalizedHtml = html
          if (unsubscribeUrl && !html.includes('{{unsubscribe_url}}')) {
            personalizedHtml = html.replace(
              '</body>',
              `<div style="text-align:center;padding:20px;font-size:12px;color:#999;"><a href="${unsubscribeUrl}" style="color:#999;">Unsubscribe</a></div></body>`
            )
          } else if (unsubscribeUrl) {
            personalizedHtml = html.replace(/\{\{unsubscribe_url\}\}/g, unsubscribeUrl)
          }

          // Create email_send_log entry
          const { data: logEntry } = await supabase.from('email_send_log').insert({
            recipient_email: email,
            from_address: fromEmail,
            subject,
            content_html: personalizedHtml,
            provider: provider.name,
            newsletter_send_id: sendId,
            status: 'queued',
            queued_at: new Date().toISOString(),
          }).select('id').single()

          // Send via provider
          const result = await provider.send({
            to: email,
            from: fromEmail,
            fromName,
            subject,
            html: personalizedHtml,
            headers: emailHeaders,
          })

          if (result.success) {
            await supabase.from('email_send_log').update({
              status: 'sent',
              sent_at: new Date().toISOString(),
              provider_message_id: result.messageId || null,
              send_attempts: 1,
            }).eq('id', logEntry?.id)
          } else {
            await supabase.from('email_send_log').update({
              status: result.retryable ? 'send_failed' : 'permanently_failed',
              failure_error: result.error,
              send_attempts: 1,
            }).eq('id', logEntry?.id)
            throw new Error(result.error || 'Send failed')
          }
        })
      )

      for (const result of results) {
        if (result.status === 'fulfilled') {
          delivered++
        } else {
          failed++
          console.error('Email send failed:', result.reason)
        }
      }

      await supabase
        .from('newsletter_sends')
        .update({ sent_count: delivered, failed_count: failed })
        .eq('id', sendId)

      if (i + BATCH_SIZE < recipientEmails.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS))
      }
    }

    await supabase
      .from('newsletter_sends')
      .update({
        status: failed === recipientEmails.length ? 'failed' : 'sent',
        completed_at: new Date().toISOString(),
        sent_count: delivered,
        failed_count: failed,
        updated_at: new Date().toISOString(),
      })
      .eq('id', sendId)

    return { success: true, delivered, failed }

  } catch (error) {
    console.error('Send processing error:', error)

    await supabase
      .from('newsletter_sends')
      .update({
        status: 'failed',
        metadata: { ...(send?.metadata || {}), error: error instanceof Error ? error.message : 'Unknown error' },
        updated_at: new Date().toISOString(),
      })
      .eq('id', sendId)

    return {
      success: false,
      delivered: 0,
      failed: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

export default handler;
Deno.serve(handler);
