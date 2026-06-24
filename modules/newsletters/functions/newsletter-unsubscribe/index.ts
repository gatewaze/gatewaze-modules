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

interface SubscriptionListView {
  id: string;
  name: string;
  description: string | null;
  subscribed: boolean;
}

/**
 * All subscription lists relevant to an email for the Subscription Centre:
 * every public list plus any non-public list the address already has a row for
 * (so they can re-subscribe), each with its current subscribed state (falling
 * back to the list's default).
 */
async function loadSubscriptionLists(supabase: any, email: string): Promise<SubscriptionListView[]> {
  const [listsRes, subsRes] = await Promise.all([
    // Internal/staff lists are never surfaced in the Subscription Centre.
    supabase.from('lists').select('id, name, description, is_public, default_subscribed').eq('is_active', true).eq('is_internal', false).order('name'),
    supabase.from('list_subscriptions').select('list_id, subscribed').eq('email', email),
  ]);
  const subMap = new Map<string, boolean>();
  for (const s of (subsRes.data ?? []) as Array<{ list_id: string; subscribed: boolean }>) {
    subMap.set(s.list_id, s.subscribed);
  }
  return ((listsRes.data ?? []) as Array<{ id: string; name: string; description: string | null; is_public: boolean; default_subscribed: boolean | null }>)
    .filter((l) => l.is_public || subMap.has(l.id))
    .map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description ?? null,
      subscribed: subMap.has(l.id) ? !!subMap.get(l.id) : !!l.default_subscribed,
    }));
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

      // Subscription Centre actions. A verified token authorises managing ANY
      // of that email's lists (not just the one the token was minted for).
      if (body.action === 'preferences' || body.action === 'set') {
        const sb = createClient(
          Deno.env.get('SUPABASE_URL')!,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        )
        if (body.action === 'preferences') {
          // Optional one-click unsubscribe-from-this-list on arrival (the
          // "Unsubscribe" footer link lands here with unsubscribe:true). Only
          // ever touches the token's OWN list_id — never an arbitrary one.
          let unsubscribedListId: string | null = null
          if (body.unsubscribe === true) {
            const nowIso = new Date().toISOString()
            await sb.from('list_subscriptions').upsert(
              {
                email: decoded.email,
                list_id: decoded.listId,
                subscribed: false,
                unsubscribed_at: nowIso,
                source: 'subscription-centre-unsubscribe',
              },
              { onConflict: 'list_id,email' }
            )
            unsubscribedListId = decoded.listId
          }
          const lists = await loadSubscriptionLists(sb, decoded.email)
          return new Response(
            JSON.stringify({ success: true, email: decoded.email, lists, unsubscribedListId }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        // action === 'set'
        if (typeof body.list_id !== 'string' || typeof body.subscribed !== 'boolean') {
          return new Response(
            JSON.stringify({ success: false, error: 'list_id (string) and subscribed (boolean) required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        const nowIso = new Date().toISOString()
        const { error: setErr } = await sb.from('list_subscriptions').upsert(
          {
            email: decoded.email,
            list_id: body.list_id,
            subscribed: body.subscribed,
            subscribed_at: body.subscribed ? nowIso : null,
            unsubscribed_at: body.subscribed ? null : nowIso,
            source: 'subscription-centre',
          },
          { onConflict: 'list_id,email' }
        )
        if (setErr) {
          console.error('Subscription set error:', setErr)
          return new Response(
            JSON.stringify({ success: false, error: 'Failed to update subscription' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
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
