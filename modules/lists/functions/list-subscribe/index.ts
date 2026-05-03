import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-api-key, x-webhook-signature',
}

/**
 * List Subscribe Edge Function
 *
 * Subscribes an email to a list. Used by external systems via webhook.
 *
 * Authentication (one of):
 *   - X-Api-Key header matching the list's api_key
 *   - X-Webhook-Signature header with HMAC-SHA256 of body using list's webhook_secret
 *
 * POST /list-subscribe
 * Body: { slug: "list-slug", email: "user@example.com" }
 *
 * Or path-based:
 * POST /list-subscribe/:slug
 * Body: { email: "user@example.com" }
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

    // Extract slug from URL path or body
    const url = new URL(req.url)
    const pathParts = url.pathname.split('/').filter(Boolean)
    const slug = (body.slug as string) || pathParts[pathParts.length - 1]
    const email = body.email as string

    if (!slug || slug === 'list-subscribe') {
      return new Response(
        JSON.stringify({ error: 'slug is required (in body or URL path)' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!email || !email.includes('@')) {
      return new Response(
        JSON.stringify({ error: 'Valid email is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Fetch list
    const { data: list, error: listError } = await supabase
      .from('lists')
      .select('*')
      .eq('slug', slug)
      .eq('is_active', true)
      .single()

    if (listError || !list) {
      return new Response(
        JSON.stringify({ error: 'List not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Verify authentication
    const apiKey = req.headers.get('x-api-key')
    const webhookSig = req.headers.get('x-webhook-signature')

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

    // Link to person if exists
    const { data: person } = await supabase
      .from('people')
      .select('id')
      .eq('email', email.toLowerCase())
      .maybeSingle()

    // Upsert subscription
    const { error: subError } = await supabase
      .from('list_subscriptions')
      .upsert({
        list_id: list.id,
        email: email.toLowerCase(),
        person_id: person?.id || null,
        subscribed: true,
        subscribed_at: new Date().toISOString(),
        unsubscribed_at: null,
        source: 'webhook',
      }, { onConflict: 'list_id,email' })

    if (subError) {
      console.error('Subscribe error:', subError)
      throw new Error('Failed to subscribe')
    }

    // Fire outbound webhook if configured
    if (list.webhook_url && list.webhook_events?.includes('subscribe')) {
      const payload = JSON.stringify({
        event: 'subscribe',
        email: email.toLowerCase(),
        list_id: list.id,
        list_slug: list.slug,
        list_name: list.name,
        timestamp: new Date().toISOString(),
        source: 'webhook',
      })

      try {
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 10000)
        await fetch(list.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          signal: controller.signal,
        })
      } catch (err) {
        console.error('Outbound webhook error:', err)
      }

      await supabase.from('list_webhook_logs').insert({
        list_id: list.id, event_type: 'subscribe',
        email: email.toLowerCase(), status: 'sent',
      })
    }

    return new Response(
      JSON.stringify({ success: true, email: email.toLowerCase(), subscribed: true, list: slug }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Subscribe handler error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
