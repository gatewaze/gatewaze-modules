import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-api-key, x-webhook-signature',
}

/**
 * List Unsubscribe Edge Function
 *
 * Unsubscribes an email from a list (or all lists). Used by external systems via webhook.
 *
 * Authentication (one of):
 *   - X-Api-Key header matching the list's api_key (or any list's key for unsubscribe-all)
 *   - X-Webhook-Signature header with HMAC-SHA256 of body using list's webhook_secret
 *
 * POST /list-unsubscribe
 * Body: { slug: "list-slug", email: "user@example.com" }
 *
 * To unsubscribe from all lists:
 * POST /list-unsubscribe
 * Body: { email: "user@example.com", all: true }
 */

async function hmacVerify(body: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  const expected = 'sha256=' + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
  return expected === signature
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  try {
    const rawBody = await req.text()
    let body: Record<string, unknown>
    try {
      body = JSON.parse(rawBody)
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const email = body.email as string
    const unsubAll = body.all === true
    const url = new URL(req.url)
    const pathParts = url.pathname.split('/').filter(Boolean)
    const slug = (body.slug as string) || (unsubAll ? null : pathParts[pathParts.length - 1])

    if (!email || !email.includes('@')) {
      return new Response(
        JSON.stringify({ error: 'Valid email is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!unsubAll && (!slug || slug === 'list-unsubscribe')) {
      return new Response(
        JSON.stringify({ error: 'slug is required (or set all: true to unsubscribe from all lists)' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const apiKey = req.headers.get('x-api-key')
    const webhookSig = req.headers.get('x-webhook-signature')

    if (unsubAll) {
      // Unsubscribe from all — verify API key against any list
      if (!apiKey) {
        return new Response(
          JSON.stringify({ error: 'X-Api-Key header required for unsubscribe-all' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const { data: matchingList } = await supabase
        .from('lists')
        .select('id')
        .eq('api_key', apiKey)
        .maybeSingle()

      if (!matchingList) {
        return new Response(
          JSON.stringify({ error: 'Invalid API key' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const { data, error } = await supabase
        .from('list_subscriptions')
        .update({
          subscribed: false,
          unsubscribed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('email', email.toLowerCase())
        .eq('subscribed', true)
        .select('list_id')

      if (error) throw error

      const count = (data || []).length

      // Fire webhooks
      if (count > 0) {
        const listIds = data!.map((s: { list_id: string }) => s.list_id)
        const { data: lists } = await supabase.from('lists').select('*').in('id', listIds)
        for (const list of lists || []) {
          if (list.webhook_url && list.webhook_events?.includes('unsubscribe')) {
            try {
              await fetch(list.webhook_url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  event: 'unsubscribe_all', email: email.toLowerCase(),
                  list_id: list.id, list_slug: list.slug, list_name: list.name,
                  timestamp: new Date().toISOString(), source: 'webhook',
                }),
              })
            } catch (err) {
              console.error('Outbound webhook error:', err)
            }
          }
        }
      }

      return new Response(
        JSON.stringify({ success: true, email: email.toLowerCase(), unsubscribed_count: count }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Single list unsubscribe
    const { data: list, error: listError } = await supabase
      .from('lists')
      .select('*')
      .eq('slug', slug!)
      .eq('is_active', true)
      .single()

    if (listError || !list) {
      return new Response(
        JSON.stringify({ error: 'List not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Verify authentication
    let authenticated = false
    if (apiKey && list.api_key && apiKey === list.api_key) {
      authenticated = true
    } else if (webhookSig && list.webhook_secret) {
      authenticated = await hmacVerify(rawBody, webhookSig, list.webhook_secret)
    }

    if (!authenticated) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized — provide X-Api-Key or X-Webhook-Signature header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Process unsubscribe
    const { error: subError } = await supabase
      .from('list_subscriptions')
      .update({
        subscribed: false,
        unsubscribed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('list_id', list.id)
      .eq('email', email.toLowerCase())

    if (subError) {
      console.error('Unsubscribe error:', subError)
      throw new Error('Failed to unsubscribe')
    }

    // Fire outbound webhook if configured
    if (list.webhook_url && list.webhook_events?.includes('unsubscribe')) {
      try {
        await fetch(list.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'unsubscribe', email: email.toLowerCase(),
            list_id: list.id, list_slug: list.slug, list_name: list.name,
            timestamp: new Date().toISOString(), source: 'webhook',
          }),
        })
      } catch (err) {
        console.error('Outbound webhook error:', err)
      }

      await supabase.from('list_webhook_logs').insert({
        list_id: list.id, event_type: 'unsubscribe',
        email: email.toLowerCase(), status: 'sent',
      })
    }

    return new Response(
      JSON.stringify({ success: true, email: email.toLowerCase(), subscribed: false, list: slug }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Unsubscribe handler error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
