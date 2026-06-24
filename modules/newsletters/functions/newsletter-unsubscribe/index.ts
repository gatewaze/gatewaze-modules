import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * Newsletter Unsubscribe.
 *
 * Two HTTP entry points, each scoped to a different caller:
 *
 *  • GET /newsletter-unsubscribe?token=...
 *    For users who click the visible footer link (fallback path when the
 *    portal Subscription Centre isn't configured — i.e. portalBaseUrl is
 *    unset). Renders an HTML confirmation page; the page's <form method=POST>
 *    is what actually unsubscribes. GET NEVER mutates state, so corporate
 *    email scanners (Mimecast TTP, Defender ATP, Proofpoint) that pre-fetch
 *    URLs cannot unsubscribe recipients without their consent.
 *
 *  • POST /newsletter-unsubscribe
 *    Three callers in practice:
 *      - RFC 8058 `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
 *        invocations from Gmail/Yahoo/Outlook (no JSON body; just the form
 *        field `List-Unsubscribe=One-Click`). One-click is REQUIRED by spec
 *        for inbox-placement; mailbox providers don't read mail headers as
 *        navigable URLs, so scanners can't reach this path.
 *      - Portal Subscription Centre XHRs: JSON body `{ token, action }` where
 *        action is 'preferences' or 'set'.
 *      - Confirmation-page form submit from the GET fallback: form-encoded
 *        `token=...&confirm=1`.
 *
 * HMAC token format: base64url(email:list_id:timestamp).signature
 * Secret in UNSUBSCRIBE_HMAC_SECRET env var (k8s + Edge synced by deploy).
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

function renderShell(title: string, body: string): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 520px; margin: 60px auto; padding: 0 24px; color: #1f2937; }
  h1 { font-size: 24px; margin: 0 0 16px; color: #111827; }
  p { font-size: 15px; line-height: 1.6; color: #4b5563; }
</style>
</head><body>
<h1>${escapeHtml(title)}</h1>
${body}
</body></html>`
}

function renderConfirmForm(actionUrl: string, recipientEmail: string): string {
  const body = `
<p>You're about to unsubscribe <strong>${escapeHtml(recipientEmail)}</strong> from this mailing list.</p>
<p style="color:#6b7280; font-size:13px;">This extra step protects you from accidental unsubscribes triggered by corporate email scanners that pre-fetch links.</p>
<form method="POST" action="${escapeHtml(actionUrl)}" style="margin-top: 24px;">
  <input type="hidden" name="confirm" value="1">
  <button type="submit" style="background:#dc2626; color:#fff; border:0; padding:12px 20px; border-radius:6px; font-size:15px; font-weight:500; cursor:pointer;">Confirm unsubscribe</button>
</form>
<p style="margin-top:16px; font-size:13px; color:#9ca3af;">If you didn't mean to unsubscribe, just close this page.</p>
`
  return renderShell('Confirm unsubscribe', body)
}

function renderSuccess(recipientEmail: string): string {
  return renderShell(
    'Unsubscribed',
    `<p>You have been unsubscribed from this mailing list.</p>
     <p style="color:#6b7280; font-size:13px;">Address: ${escapeHtml(recipientEmail)}</p>
     <p style="color:#6b7280; font-size:13px;">If this was a mistake, you can re-subscribe from your profile settings or any future email.</p>`,
  )
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
      // GET renders a confirmation page — it never mutates state. This
      // protects against corporate email scanners that pre-fetch URLs.
      const url = new URL(req.url)
      const token = url.searchParams.get('token')

      if (!token) {
        return new Response(
          renderShell('Missing unsubscribe token', 'No token was provided. Use the link in a recent email.'),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'text/html' } }
        )
      }

      const decoded = decodeToken(token)
      if (!decoded) {
        return new Response(
          renderShell('Invalid unsubscribe link', 'This link is malformed. Use the link in a recent email.'),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'text/html' } }
        )
      }

      const valid = await hmacVerify(decoded.payloadStr, decoded.signature, hmacSecret)
      if (!valid) {
        return new Response(
          renderShell('Invalid or expired unsubscribe link', 'This link could not be verified. Use the link in a recent email.'),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'text/html' } }
        )
      }

      const tokenAge = Date.now() - decoded.timestamp
      if (tokenAge > 90 * 24 * 60 * 60 * 1000) {
        return new Response(
          renderShell('This unsubscribe link has expired', 'Please use the link in a more recent email.'),
          { status: 410, headers: { ...corsHeaders, 'Content-Type': 'text/html' } }
        )
      }

      // Token is valid — render the confirmation form. The form POSTs back
      // to this same URL with confirm=1, which is the only path that
      // mutates list_subscriptions. The escapeHtml call defends the email
      // display against XSS even though the token is HMAC-signed.
      return new Response(
        renderConfirmForm(req.url, decoded.email),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'text/html' } }
      )
    } else if (req.method === 'POST') {
      // POST carries one of three shapes:
      //   1. JSON  { token, action: 'preferences'|'set', ... }  — Subscription Centre XHRs
      //   2. form  token=...&confirm=1                          — confirmation-form submit
      //   3. form  List-Unsubscribe=One-Click  (token in URL)   — RFC 8058 one-click
      // Read the body as text once and branch on content-type to keep all three paths working.
      const contentType = (req.headers.get('content-type') ?? '').toLowerCase()
      let body: Record<string, unknown> = {}
      if (contentType.includes('application/json')) {
        body = await req.json()
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(await req.text())
        body = Object.fromEntries(params.entries())
      }

      // RFC 8058 / confirmation-form: token may live in the URL rather than the body.
      if (!body.token) {
        const tokenFromUrl = new URL(req.url).searchParams.get('token')
        if (tokenFromUrl) body.token = tokenFromUrl
      }

      // RFC 8058 mailbox-provider POST (Gmail/Yahoo): no JSON action, body is just
      // `List-Unsubscribe=One-Click`. Treat as one-click unsubscribe of the token's list.
      const isRfc8058 = !body.action && body['List-Unsubscribe'] === 'One-Click'
      if (isRfc8058 && !body.confirm) {
        // Mark confirm=true implicitly — the mailbox provider's POST IS the user's intent.
        body.confirm = '1'
      }

      if (!body.token) {
        return new Response(
          JSON.stringify({ success: false, error: 'Token required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const tokenStr = String(body.token)
      const decoded = decodeToken(tokenStr)
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
          // The Subscription Centre may opt to unsubscribe-from-this-list on
          // arrival (its confirmation panel POSTs `unsubscribe:true` after
          // the recipient clicks "Confirm unsubscribe"). Only ever touches
          // the token's OWN list_id — never an arbitrary one.
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

      // Fallthrough POST = confirmation-form submit OR RFC 8058 one-click.
      // Both must set `confirm=1` (RFC 8058 path implicitly does this above).
      // Anything else lacking confirm/action is rejected — prevents accidental
      // mutation from a malformed XHR.
      if (!body.confirm) {
        return new Response(
          JSON.stringify({ success: false, error: 'Missing action or confirm flag' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
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

    // Process unsubscribe (confirmation-form OR RFC 8058 paths only — GET
    // never reaches here; preferences/set returned earlier with their own
    // JSON response).
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

    // Render an HTML success page when the POST came from our confirmation
    // form (the browser submitted a form, so a 200 with HTML body is the
    // natural response). RFC 8058 callers (Gmail/Yahoo) get JSON — they
    // don't render the response anywhere; only the status code matters.
    const acceptsHtml = (req.headers.get('accept') ?? '').includes('text/html')
    if (acceptsHtml) {
      return new Response(
        renderSuccess(email),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'text/html' } }
      )
    }

    return new Response(
      JSON.stringify({ success: true, message: 'Unsubscribed successfully' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Unsubscribe handler error:', error)

    const acceptsHtml = (req.headers.get('accept') ?? '').includes('text/html')
    if (acceptsHtml) {
      return new Response(
        renderShell('Something went wrong', '<p>Please try again later or contact support.</p>'),
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
