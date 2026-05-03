import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * Newsletter One-Click Unsubscribe
 *
 * Supports two modes:
 * 1. GET /newsletter-unsubscribe?token=HMAC_TOKEN — HMAC-signed one-click unsubscribe (RFC 8058)
 * 2. POST /newsletter-unsubscribe — JSON body with { token }
 *
 * HMAC token format: base64url(email:list_id:timestamp).signature
 * The HMAC secret is stored in UNSUBSCRIBE_HMAC_SECRET env var.
 */

async function hmacSign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function hmacVerify(payload: string, signature: string, secret: string): Promise<boolean> {
  const expected = await hmacSign(payload, secret)
  return expected === signature
}

function decodeToken(token: string): { email: string; listId: string; timestamp: number; payloadStr: string; signature: string } | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 2) return null

    const [encodedPayload, signature] = parts
    const payloadStr = atob(encodedPayload.replace(/-/g, '+').replace(/_/g, '/'))
    const [email, listId, timestampStr] = payloadStr.split(':')

    if (!email || !listId || !timestampStr) return null

    return { email, listId, timestamp: parseInt(timestampStr, 10), payloadStr, signature }
  } catch {
    return null
  }
}

async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const hmacSecret = Deno.env.get('UNSUBSCRIBE_HMAC_SECRET')
  if (!hmacSecret) {
    return new Response(
      JSON.stringify({ success: false, error: 'Unsubscribe not configured' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  try {
    let email: string
    let listId: string

    if (req.method === 'GET') {
      const url = new URL(req.url)
      const token = url.searchParams.get('token')

      if (!token) {
        return new Response(
          '<html><body><h1>Missing unsubscribe token</h1></body></html>',
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'text/html' } }
        )
      }

      const decoded = decodeToken(token)
      if (!decoded) {
        return new Response(
          '<html><body><h1>Invalid unsubscribe link</h1></body></html>',
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'text/html' } }
        )
      }

      const valid = await hmacVerify(decoded.payloadStr, decoded.signature, hmacSecret)
      if (!valid) {
        return new Response(
          '<html><body><h1>Invalid or expired unsubscribe link</h1></body></html>',
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'text/html' } }
        )
      }

      // Token valid for 90 days
      const tokenAge = Date.now() - decoded.timestamp
      if (tokenAge > 90 * 24 * 60 * 60 * 1000) {
        return new Response(
          '<html><body><h1>This unsubscribe link has expired</h1><p>Please use the link in a more recent email.</p></body></html>',
          { status: 410, headers: { ...corsHeaders, 'Content-Type': 'text/html' } }
        )
      }

      email = decoded.email
      listId = decoded.listId
    } else if (req.method === 'POST') {
      const body = await req.json()

      if (!body.token) {
        return new Response(
          JSON.stringify({ success: false, error: 'Token required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const decoded = decodeToken(body.token)
      if (!decoded) {
        return new Response(
          JSON.stringify({ success: false, error: 'Invalid token' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const valid = await hmacVerify(decoded.payloadStr, decoded.signature, hmacSecret)
      if (!valid) {
        return new Response(
          JSON.stringify({ success: false, error: 'Invalid token signature' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      email = decoded.email
      listId = decoded.listId
    } else {
      return new Response(
        JSON.stringify({ success: false, error: 'Method not allowed' }),
        { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Process unsubscribe
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { error } = await supabase
      .from('list_subscriptions')
      .upsert(
        {
          email,
          list_id: listId,
          subscribed: false,
          unsubscribed_at: new Date().toISOString(),
          source: 'one-click-unsubscribe',
        },
        { onConflict: 'list_id,email' }
      )

    if (error) {
      console.error('Unsubscribe error:', error)
      throw new Error('Failed to process unsubscribe')
    }

    if (req.method === 'GET') {
      return new Response(
        `<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family: Arial, sans-serif; max-width: 500px; margin: 40px auto; padding: 20px; text-align: center;">
  <h1 style="color: #333;">Unsubscribed</h1>
  <p style="color: #666; font-size: 16px;">You have been successfully unsubscribed from this mailing list.</p>
  <p style="color: #999; font-size: 14px; margin-top: 24px;">If this was a mistake, you can re-subscribe from your profile settings.</p>
</body>
</html>`,
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'text/html' } }
      )
    }

    return new Response(
      JSON.stringify({ success: true, message: 'Unsubscribed successfully' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Unsubscribe handler error:', error)

    if (req.method === 'GET') {
      return new Response(
        '<html><body><h1>Something went wrong</h1><p>Please try again later or contact support.</p></body></html>',
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'text/html' } }
      )
    }

    return new Response(
      JSON.stringify({ success: false, error: 'Internal error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
}

export default handler;
Deno.serve(handler);
