import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

/**
 * Newsletter signup (public, portal-facing).
 *
 * The portal calls this the same way it calls other backend mutations — via the Supabase functions
 * URL (`${supabaseUrl}/functions/v1/newsletter-signup`) with the anon key — because the portal
 * client only has the Supabase URL, not the separate API host.
 *
 * Subscribing is double opt-in:
 *   - Anonymous: records a request (newsletters_signup_confirmations, migration 091) and emails a
 *     confirmation link. Nothing is subscribed, no person is created, and an unsubscribed address is
 *     NOT reactivated until the owner of the address confirms.
 *   - Signed in, subscribing one of their own addresses: subscribed straight away (already verified).
 *
 * Confirming is scanner-safe, like newsletter-unsubscribe: a link only ever SHOWS a page with a
 * button; the subscription is made by the POST that button sends. The emailed link goes to the
 * portal (`${PORTAL_URL}/newsletters?confirm=<token>`) when PORTAL_URL is set, otherwise to this
 * function's own GET page.
 *
 * Every subscription made here records what was agreed to in list_subscriptions.metadata.consent:
 * method, the consent wording shown, when, and from which IP.
 *
 * Actions (JSON POST): subscribe (default) · confirm-info · confirm · status · unsubscribe.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

// The service client, passed between helpers (the generated types are not
// available to edge functions; newsletter-unsubscribe does the same).
// deno-lint-ignore no-explicit-any
type Sb = any

const CONFIRMATIONS = 'newsletters_signup_confirmations'
const EMAIL_RE = /^[^@\s,<>]+@[^@\s,<>]+\.[^@\s,<>]+$/
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const MAX_PER_IP_PER_HOUR = 20
const MAX_PER_EMAIL_PER_DAY = 5
// A second request for the same newsletter inside this window sends nothing.
const RESEND_GAP_MS = 10 * 60 * 1000

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

function serviceClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

function clientIp(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for') || ''
  const ip = (req.headers.get('cf-connecting-ip') || fwd.split(',')[0] || '').trim()
  return ip ? ip.slice(0, 64) : null
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

async function setting(supabase: Sb, key: string): Promise<string> {
  const { data } = await supabase.from('platform_settings').select('value').eq('key', key).maybeSingle()
  const v = data?.value
  return typeof v === 'string' ? v.trim() : ''
}

/** The per-brand marketing-consent wording shown beside the signup form. */
function consentText(supabase: Sb): Promise<string> {
  return setting(supabase, 'newsletter_consent_html')
}

/**
 * Who confirmation emails come from: platform_settings
 * newsletter_confirmation_from_address (name: newsletter_confirmation_from_name,
 * else app_name), falling back to the EMAIL_FROM env var. Replies go to
 * contact_email when one is set.
 */
async function senderFor(supabase: Sb) {
  const address = (await setting(supabase, 'newsletter_confirmation_from_address')) || (Deno.env.get('EMAIL_FROM') || '').trim()
  if (!address || !EMAIL_RE.test(address)) return null
  const brand = (await setting(supabase, 'app_name')) || 'our newsletter'
  const name = (await setting(supabase, 'newsletter_confirmation_from_name')) || brand
  const replyTo = await setting(supabase, 'contact_email')
  return { address, name, brand, replyTo: EMAIL_RE.test(replyTo) ? replyTo : null }
}

function confirmLink(token: string): string {
  const portal = (Deno.env.get('PORTAL_URL') || '').trim().replace(/\/+$/, '')
  if (/^https:\/\//.test(portal)) return `${portal}/newsletters?confirm=${token}`
  return `${Deno.env.get('SUPABASE_URL')}/functions/v1/newsletter-signup?confirm=${token}`
}

function confirmationEmail({ newsletter, brand, link }: { newsletter: string; brand: string; link: string }) {
  const subject = `Confirm your subscription to ${newsletter}`
  const text = [
    `Please confirm that you want to receive ${newsletter} from ${brand}.`,
    '',
    `Confirm your subscription: ${link}`,
    '',
    "If you didn't ask for this, ignore this email — you won't be subscribed and we won't email you again about it.",
  ].join('\n')
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:8px;padding:32px">
<tr><td>
<h1 style="font-size:20px;margin:0 0 16px;color:#111827">Confirm your subscription</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 24px">Please confirm that you want to receive <strong>${escapeHtml(newsletter)}</strong> from ${escapeHtml(brand)}.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-size:15px;font-weight:600">Confirm subscription</a></p>
<p style="font-size:13px;line-height:1.6;color:#6b7280;margin:0">If you didn't ask for this, ignore this email — you won't be subscribed and we won't email you again about it.</p>
</td></tr></table></td></tr></table></body></html>`
  return { subject, html, text }
}

async function collectionFor(supabase: Sb, slug: string) {
  const { data } = await supabase
    .from('newsletters_template_collections')
    .select('slug, name, list_id')
    .eq('slug', slug)
    .maybeSingle()
  return data as { slug: string; name: string; list_id: string | null } | null
}

/**
 * Subscribe an address whose owner has just proven it is theirs (confirmed the
 * email, or is signed in as them). This is the only place this function sets
 * subscribed = true. Existing metadata is kept; the consent record is added.
 */
async function subscribeConfirmed(
  supabase: Sb,
  { listId, email, consent }: { listId: string; email: string; consent: Record<string, unknown> },
): Promise<void> {
  // Find or create the person now, once the address is confirmed.
  let personId: string | null = null
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/people-signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      },
      body: JSON.stringify({ email, source: 'newsletter-signup' }),
    })
    personId = (await res.json().catch(() => ({})))?.person_id ?? null
  } catch (_e) { /* fall through to a lookup */ }
  if (!personId) {
    const { data } = await supabase.from('people').select('id').eq('email', email).maybeSingle()
    personId = data?.id ?? null
  }

  const { data: existing } = await supabase
    .from('list_subscriptions')
    .select('metadata, person_id')
    .eq('list_id', listId)
    .eq('email', email)
    .maybeSingle()
  const metadata = { ...(existing?.metadata ?? {}), consent }
  const { error } = await supabase.from('list_subscriptions').upsert(
    {
      list_id: listId,
      person_id: existing?.person_id ?? personId,
      email,
      subscribed: true,
      subscribed_at: new Date().toISOString(),
      unsubscribed_at: null,
      source: 'newsletter-signup',
      metadata,
    },
    { onConflict: 'list_id,email' },
  )
  if (error) throw new Error(`could not subscribe: ${error.message}`)
}

type ConfirmResult =
  | { ok: true; email: string; newsletter: string; already: boolean }
  | { ok: false; reason: 'invalid' | 'expired' }

/** Look up a confirmation request by its token (never by anything guessable). */
async function findRequest(supabase: Sb, token: string) {
  if (!TOKEN_RE.test(token)) return null
  const { data } = await supabase
    .from(CONFIRMATIONS)
    .select('id, email, list_id, collection_slug, consent_html, request_ip, created_at, expires_at, confirmed_at')
    .eq('token_hash', await sha256Hex(token))
    .maybeSingle()
  return data
}

async function newsletterName(supabase: Sb, slug: string | null, listId: string) {
  if (slug) {
    const col = await collectionFor(supabase, slug)
    if (col?.name) return col.name
  }
  const { data } = await supabase.from('lists').select('name').eq('id', listId).maybeSingle()
  return data?.name || 'the newsletter'
}

async function confirmInfo(supabase: Sb, token: string): Promise<ConfirmResult> {
  const r = await findRequest(supabase, token)
  if (!r) return { ok: false, reason: 'invalid' }
  const newsletter = await newsletterName(supabase, r.collection_slug, r.list_id)
  if (r.confirmed_at) return { ok: true, email: r.email, newsletter, already: true }
  if (new Date(r.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' }
  return { ok: true, email: r.email, newsletter, already: false }
}

/**
 * Whether the compliance module holds a suppression for this address (an
 * erasure or a marketing objection). False when compliance isn't installed.
 */
async function isSuppressed(supabase: Sb, email: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('compliance_is_suppressed', { p_email: email })
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') return false
    throw new Error(`suppression check failed: ${error.message}`)
  }
  return data === true
}

/**
 * The person confirmed the emailed link, which proves they control the
 * address, so their new consent replaces any compliance suppression.
 */
async function liftSuppression(supabase: Sb, email: string): Promise<void> {
  const { error } = await supabase.rpc('compliance_lift_suppression', { p_email: email, p_reason: 'double_opt_in' })
  if (error && error.code !== 'PGRST202' && error.code !== '42883') {
    throw new Error(`could not lift suppression: ${error.message}`)
  }
}

async function confirm(supabase: Sb, token: string, req: Request): Promise<ConfirmResult> {
  const r = await findRequest(supabase, token)
  if (!r) return { ok: false, reason: 'invalid' }
  const newsletter = await newsletterName(supabase, r.collection_slug, r.list_id)
  if (r.confirmed_at) return { ok: true, email: r.email, newsletter, already: true }
  if (new Date(r.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' }

  // Claim the request first so two clicks cannot both subscribe.
  const confirmedAt = new Date().toISOString()
  const { data: claimed } = await supabase
    .from(CONFIRMATIONS)
    .update({ confirmed_at: confirmedAt, confirm_ip: clientIp(req) })
    .eq('id', r.id)
    .is('confirmed_at', null)
    .select('id')
  if (!claimed || claimed.length === 0) return { ok: true, email: r.email, newsletter, already: true }

  try {
    await liftSuppression(supabase, r.email)
    await subscribeConfirmed(supabase, {
      listId: r.list_id,
      email: r.email,
      consent: {
        method: 'double_opt_in',
        text: r.consent_html,
        requested_at: r.created_at,
        request_ip: r.request_ip,
        confirmed_at: confirmedAt,
        confirm_ip: clientIp(req),
        collection: r.collection_slug,
      },
    })
  } catch (err) {
    // Release the claim so the link still works once the problem is fixed.
    await supabase.from(CONFIRMATIONS).update({ confirmed_at: null, confirm_ip: null }).eq('id', r.id)
    throw err
  }
  return { ok: true, email: r.email, newsletter, already: false }
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 520px; margin: 60px auto; padding: 0 24px; color: #1f2937; }
  h1 { font-size: 24px; margin: 0 0 16px; color: #111827; }
  p { font-size: 15px; line-height: 1.6; color: #4b5563; }
  button { background: #111827; color: #fff; border: 0; padding: 12px 20px; border-radius: 6px; font-size: 15px; font-weight: 500; cursor: pointer; }
</style>
</head><body>
<h1>${escapeHtml(title)}</h1>
${body}
</body></html>`
  return new Response(html, {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  })
}

function resultPage(r: ConfirmResult): Response {
  if (!r.ok) {
    return r.reason === 'expired'
      ? page('Link expired', '<p>This confirmation link has expired. Sign up again and we will send you a new one.</p>', 410)
      : page('Link not valid', '<p>This confirmation link is not valid. Sign up again and we will send you a new one.</p>', 404)
  }
  return page(
    r.already ? 'Already confirmed' : 'You’re subscribed',
    `<p>${escapeHtml(r.email)} is subscribed to <strong>${escapeHtml(r.newsletter)}</strong>.</p>
     <p style="font-size:13px;color:#6b7280">You can unsubscribe at any time from the link at the bottom of every email.</p>`,
  )
}

/**
 * Resolve every email the JWT's user owns: their auth email, their people-row
 * email and any person_emails aliases. Server-derived so unsubscribe/status
 * can never act on someone else's address.
 */
async function callerEmails(supabase: Sb, req: Request): Promise<string[] | null> {
  const auth = req.headers.get('authorization') || ''
  const jwt = auth.replace(/^Bearer\s+/i, '')
  if (!jwt || jwt === Deno.env.get('SUPABASE_ANON_KEY')) return null
  const { data, error } = await supabase.auth.getUser(jwt)
  if (error || !data?.user) return null
  const emails = new Set<string>()
  if (data.user.email) emails.add(data.user.email.toLowerCase())
  const { data: person } = await supabase
    .from('people')
    .select('id, email')
    .eq('auth_user_id', data.user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (person?.email) emails.add(String(person.email).toLowerCase())
  if (person?.id) {
    const { data: aliases } = await supabase.from('person_emails').select('email').eq('person_id', person.id)
    for (const a of aliases ?? []) if (a.email) emails.add(String(a.email).toLowerCase())
  }
  return emails.size ? [...emails] : null
}

async function listIdFor(supabase: Sb, collection: string): Promise<string | null> {
  const { data: col } = await supabase
    .from('newsletters_template_collections')
    .select('list_id')
    .eq('slug', collection)
    .maybeSingle()
  return col?.list_id ?? null
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  // The fallback confirmation page (when PORTAL_URL is not set): GET only
  // shows a button; it never subscribes, so link scanners cannot confirm.
  if (req.method === 'GET') {
    const token = new URL(req.url).searchParams.get('confirm') || ''
    try {
      const info = await confirmInfo(serviceClient(), token)
      if (!info.ok || info.already) return resultPage(info)
      return page(
        'Confirm your subscription',
        `<p>Subscribe <strong>${escapeHtml(info.email)}</strong> to <strong>${escapeHtml(info.newsletter)}</strong>?</p>
         <form method="POST" action="" style="margin-top:24px">
           <input type="hidden" name="token" value="${escapeHtml(token)}">
           <button type="submit">Confirm subscription</button>
         </form>
         <p style="font-size:13px;color:#9ca3af;margin-top:16px">If you didn't ask for this, close this page — you won't be subscribed.</p>`,
      )
    } catch (err) {
      console.error('newsletter-signup confirm page failed', err instanceof Error ? err.message : err)
      return page('Something went wrong', '<p>Please try the link again in a moment.</p>', 500)
    }
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // The fallback page's button (form-encoded POST).
  if ((req.headers.get('content-type') || '').includes('application/x-www-form-urlencoded')) {
    try {
      const form = new URLSearchParams(await req.text())
      return resultPage(await confirm(serviceClient(), form.get('token') || '', req))
    } catch (err) {
      console.error('newsletter-signup confirm failed', err instanceof Error ? err.message : err)
      return page('Something went wrong', '<p>Please try the link again in a moment.</p>', 500)
    }
  }

  try {
    const { email: rawEmail, collection, action, token } = await req.json().catch(() => ({}))

    // The portal's confirmation panel (/newsletters?confirm=<token>).
    if (action === 'confirm-info' || action === 'confirm') {
      const supabase = serviceClient()
      const r = action === 'confirm'
        ? await confirm(supabase, String(token || ''), req)
        : await confirmInfo(supabase, String(token || ''))
      if (!r.ok) return json({ ok: false, reason: r.reason }, r.reason === 'expired' ? 410 : 404)
      return json(r, 200)
    }

    // Signed-in actions: subscription status + unsubscribe. Both act only on
    // emails resolved from the caller's OWN JWT.
    if (action === 'status' || action === 'unsubscribe') {
      const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
      const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

      if (!collection) return json({ error: 'collection required' }, 400)
      const emails = await callerEmails(supabase, req)
      if (!emails) return json({ error: 'Sign-in required' }, 401)
      const listId = await listIdFor(supabase, String(collection))
      if (!listId) return json({ subscribed: false, email: null }, 200)

      if (action === 'status') {
        const { data: subs } = await supabase
          .from('list_subscriptions')
          .select('email, subscribed')
          .eq('list_id', listId)
          .in('email', emails)
        const active = (subs ?? []).find((s) => s.subscribed)
        return json({ subscribed: !!active, email: active?.email ?? null }, 200)
      }

      // unsubscribe
      const { data: updated, error } = await supabase
        .from('list_subscriptions')
        .update({ subscribed: false, unsubscribed_at: new Date().toISOString() })
        .eq('list_id', listId)
        .in('email', emails)
        .eq('subscribed', true)
        .select('email')
      if (error) return json({ error: error.message }, 500)
      return json({ success: true, unsubscribed: (updated ?? []).map((r) => r.email) }, 200)
    }

    const email = String(rawEmail || '').toLowerCase().trim()
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
      return json({ error: 'A valid email is required' }, 400)
    }
    if (!collection) return json({ error: 'collection required' }, 400)

    const supabase = serviceClient()
    const col = await collectionFor(supabase, String(collection))
    // No list linked to this newsletter → nothing to subscribe to. Say so
    // without creating anyone.
    if (!col?.list_id) return json({ success: true, pending: false, subscribed: false }, 200)

    // Signed in and subscribing one of their own addresses: the address is
    // already proven theirs, so subscribe now (this is also how someone who
    // unsubscribed changes their mind).
    // A suppressed address (erased, or objected to marketing) must confirm by
    // email even when signed in: accounts can be created without proving
    // the address, so only the emailed link shows the person controls it.
    const owned = await callerEmails(supabase, req)
    if (owned && owned.includes(email) && !(await isSuppressed(supabase, email))) {
      const consentHtml = await consentText(supabase)
      await subscribeConfirmed(supabase, {
        listId: col.list_id,
        email,
        consent: {
          method: 'signed_in',
          text: consentHtml,
          at: new Date().toISOString(),
          ip: clientIp(req),
          collection: col.slug,
        },
      })
      return json({ success: true, subscribed: true }, 200)
    }

    // Anonymous (or someone else's address): record the request and email a
    // confirmation link. Nothing is subscribed, created or reactivated until
    // the owner of the address confirms. The response is the same whatever
    // the address's current state, so the form cannot be used to find out
    // who is subscribed.
    const ip = clientIp(req)
    const since = (ms: number) => new Date(Date.now() - ms).toISOString()

    if (ip) {
      const { count: perIp } = await supabase
        .from(CONFIRMATIONS)
        .select('id', { count: 'exact', head: true })
        .eq('request_ip', ip)
        .gte('created_at', since(HOUR))
      if ((perIp ?? 0) >= MAX_PER_IP_PER_HOUR) return json({ error: 'Too many signups — please try again later.' }, 429)
    }

    const { data: recent } = await supabase
      .from(CONFIRMATIONS)
      .select('list_id, created_at')
      .eq('email', email)
      .gte('created_at', since(DAY))
    const sameListRecently = (recent ?? []).some(
      (r) => r.list_id === col.list_id && new Date(r.created_at).getTime() > Date.now() - RESEND_GAP_MS,
    )
    const { data: existing } = await supabase
      .from('list_subscriptions')
      .select('subscribed')
      .eq('list_id', col.list_id)
      .eq('email', email)
      .maybeSingle()

    // Already subscribed, asked a moment ago, or asked too often today: send
    // nothing, answer as usual.
    if (existing?.subscribed || sameListRecently || (recent ?? []).length >= MAX_PER_EMAIL_PER_DAY) {
      return json({ success: true, pending: true }, 200)
    }

    const from = await senderFor(supabase)
    if (!from) {
      console.error('newsletter-signup: no confirmation sender configured (platform_settings.newsletter_confirmation_from_address or EMAIL_FROM)')
      return json({ error: 'Signup is unavailable right now — please try again later.' }, 503)
    }

    const confirmToken = randomToken()
    const consentHtml = await consentText(supabase)
    const { data: row, error: insErr } = await supabase
      .from(CONFIRMATIONS)
      .insert({
        token_hash: await sha256Hex(confirmToken),
        email,
        list_id: col.list_id,
        collection_slug: col.slug,
        consent_html: consentHtml,
        request_ip: ip,
        request_user_agent: (req.headers.get('user-agent') || '').slice(0, 300) || null,
      })
      .select('id')
      .single()
    if (insErr || !row) {
      console.error('newsletter-signup: could not record the request', insErr?.message)
      return json({ error: 'Signup failed — please try again.' }, 500)
    }

    const link = confirmLink(confirmToken)
    const mail = confirmationEmail({ newsletter: col.name, brand: from.brand, link })
    const { error: sendErr } = await supabase.functions.invoke('email-send', {
      body: {
        to: email,
        from: from.address,
        fromName: from.name,
        ...(from.replyTo ? { replyTo: from.replyTo } : {}),
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      },
    })
    if (sendErr) {
      console.error('newsletter-signup: confirmation email failed', sendErr.message)
      return json({ error: 'We could not send the confirmation email — please try again.' }, 502)
    }
    await supabase.from(CONFIRMATIONS).update({ emailed_at: new Date().toISOString() }).eq('id', row.id)

    return json({ success: true, pending: true }, 200)
  } catch (err) {
    console.error('newsletter-signup failed', err instanceof Error ? err.message : err)
    return json({ error: 'Signup failed' }, 500)
  }
}

Deno.serve(handler)
