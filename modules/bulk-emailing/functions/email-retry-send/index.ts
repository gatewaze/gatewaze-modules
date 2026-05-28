import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getEmailProvider } from '../_shared/provider-registry.ts'
import { calculateNextRetry } from '../_shared/retry.ts'

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

export default async function(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const logIds: string[] = body.log_ids

    if (!logIds || !Array.isArray(logIds) || logIds.length === 0) {
      return new Response(JSON.stringify({ error: 'log_ids array is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const provider = await getEmailProvider(supabase)

    let retried = 0
    let succeeded = 0
    let failed = 0
    let permanentlyFailed = 0

    for (const logId of logIds) {
      const { data: log, error } = await supabase
        .from('email_send_log')
        .select('*')
        .eq('id', logId)
        .eq('status', 'send_failed')
        .single()

      if (error || !log) continue
      if (log.send_attempts >= log.max_attempts) {
        await supabase.from('email_send_log').update({
          status: 'permanently_failed',
          next_retry_at: null,
        }).eq('id', logId)
        permanentlyFailed++
        continue
      }

      retried++

      // Re-render content if we only stored template reference
      let html = log.content_html
      if (!html && log.template_id) {
        const { data: template } = await supabase
          .from('email_templates')
          .select('html_body')
          .eq('id', log.template_id)
          .single()
        html = template?.html_body || ''
        // TODO: apply template_variables if needed
      }

      if (!html) {
        await supabase.from('email_send_log').update({
          status: 'permanently_failed',
          failure_error: 'No content available for retry',
          next_retry_at: null,
        }).eq('id', logId)
        permanentlyFailed++
        continue
      }

      const result = await provider.send({
        to: log.recipient_email,
        from: log.from_address,
        subject: log.subject,
        html,
        replyTo: log.reply_to || undefined,
      })

      const newAttempts = log.send_attempts + 1

      if (result.success) {
        await supabase.from('email_send_log').update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          provider_message_id: result.messageId || null,
          send_attempts: newAttempts,
          next_retry_at: null,
          failure_error: null,
        }).eq('id', logId)
        succeeded++

        // Update parent batch job counters if applicable
        if (log.batch_job_id) {
          await supabase.rpc('email_batch_job_retry_success', {
            p_job_id: log.batch_job_id,
          }).catch(() => {})
        }
      } else {
        const isRetryable = result.retryable
        const nextRetry = isRetryable ? calculateNextRetry(newAttempts, log.max_attempts) : null
        const status = nextRetry ? 'send_failed' : 'permanently_failed'

        await supabase.from('email_send_log').update({
          status,
          failure_error: result.error || 'Unknown error',
          send_attempts: newAttempts,
          next_retry_at: nextRetry,
        }).eq('id', logId)

        if (status === 'permanently_failed') permanentlyFailed++
        else failed++
      }
    }

    return new Response(JSON.stringify({
      retried, succeeded, failed, permanently_failed: permanentlyFailed,
    }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error: any) {
    console.error('email-retry-send error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
}
