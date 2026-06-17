import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'
import { getEmailProvider } from '../_shared/provider-registry.ts'
import type { EmailProviderModule } from '../_shared/email-provider.ts'
import {
  extractTrackableLinks,
  generateTrackingKey,
  tagHtmlLinks,
  type LinkSourceBlock,
  type TaggableLink,
} from '../_shared/link-tracking.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = ReturnType<typeof createClient<any, any, any>>

/**
 * Per-collection feature flag for link tracking. Default ON; an explicit
 * `false`/`'off'` in collection metadata disables it.
 */
async function isLinkTrackingEnabled(supabase: SB, collectionId: string): Promise<boolean> {
  const { data } = await supabase
    .from('newsletters_template_collections')
    .select('metadata')
    .eq('id', collectionId)
    .maybeSingle()
  const meta = (data as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}
  return meta.link_tracking !== false && meta.link_tracking !== 'off'
}

/**
 * Extract every trackable link in the edition, upsert the per-occurrence
 * registry (assigning a stable tracking_key per (block, field, index)), and
 * return the rows in document order for HTML tagging.
 */
async function syncEditionLinkRegistry(supabase: SB, editionId: string): Promise<TaggableLink[]> {
  const { data: blocks, error } = await supabase
    .from('newsletters_edition_blocks')
    .select(
      'id, block_type, content, sort_order, tracking_slug, bricks:newsletters_edition_bricks(id, brick_type, content, sort_order)',
    )
    .eq('edition_id', editionId)
  if (error || !blocks) return []

  const occ = extractTrackableLinks(blocks as unknown as LinkSourceBlock[])
  if (occ.length === 0) return []

  const { data: existing } = await supabase
    .from('newsletters_edition_links')
    .select('block_id, field, link_index, tracking_key')
    .eq('edition_id', editionId)
  const occKey = (b: string, f: string, i: number) => `${b}|${f}|${i}`
  const existingKey = new Map<string, string>()
  for (const r of (existing ?? []) as Array<{ block_id: string; field: string; link_index: number; tracking_key: string }>) {
    existingKey.set(occKey(r.block_id, r.field, r.link_index), r.tracking_key)
  }

  const rows = occ.map((o) => ({
    edition_id: editionId,
    block_id: o.block_id,
    brick_id: o.brick_id,
    block_type: o.block_type,
    tracking_slug: o.tracking_slug,
    field: o.field,
    link_index: o.link_index,
    original_url: o.original_url,
    tracking_key: existingKey.get(occKey(o.block_id, o.field, o.link_index)) ?? generateTrackingKey(),
  }))

  const { error: upsertError } = await supabase
    .from('newsletters_edition_links')
    .upsert(rows, { onConflict: 'block_id,field,link_index' })
  if (upsertError) {
    console.warn('[newsletter-send] registry upsert failed:', upsertError.message)
    return []
  }

  return rows.map((r) => ({ original_url: r.original_url, tracking_key: r.tracking_key }))
}

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
// Weather substitution (open-meteo)
// ---------------------------------------------------------------------------
//
// The Weather block (see admin/components/puck/email-blocks/blocks/Weather.tsx)
// publishes HTML containing four Mustache placeholders:
//   {{weather_emoji}}  {{weather_temp}}  {{weather_summary}}  {{weather_location}}
// plus a `<!--gw-weather-units:celsius|fahrenheit-->` comment marker that
// tells us which unit the block was configured for.
//
// The lookup uses `people.attributes->>'city'` and `attributes->>'country'`
// for the recipient (matched by email). We cache by (city|country|units)
// within a single send so duplicate locations only hit open-meteo once.

interface WeatherResolved {
  emoji: string;
  temp: string;
  summary: string;
  location: string;
}

const WEATHER_UNAVAILABLE_SUMMARY = 'Weather unavailable for your location.';

function weatherCodeToEmoji(code: number): { emoji: string; summary: string } {
  if (code === 0) return { emoji: '☀️', summary: 'Clear sky' }
  if (code === 1) return { emoji: '🌤️', summary: 'Mainly clear' }
  if (code === 2) return { emoji: '⛅', summary: 'Partly cloudy' }
  if (code === 3) return { emoji: '☁️', summary: 'Overcast' }
  if (code === 45 || code === 48) return { emoji: '🌫️', summary: 'Fog' }
  if (code >= 51 && code <= 57) return { emoji: '🌦️', summary: 'Drizzle' }
  if (code >= 61 && code <= 67) return { emoji: '🌧️', summary: 'Rain' }
  if (code >= 71 && code <= 77) return { emoji: '🌨️', summary: 'Snow' }
  if (code >= 80 && code <= 82) return { emoji: '🌧️', summary: 'Rain showers' }
  if (code === 85 || code === 86) return { emoji: '🌨️', summary: 'Snow showers' }
  if (code >= 95 && code <= 99) return { emoji: '⛈️', summary: 'Thunderstorm' }
  return { emoji: '🌡️', summary: 'Weather' }
}

function extractWeatherUnits(html: string): 'celsius' | 'fahrenheit' {
  // First matching marker wins. Multiple weather blocks in one edition
  // share the same unit setting in practice (and even if they don't,
  // mixing units in a single email would be confusing).
  const m = html.match(/<!--gw-weather-units:(celsius|fahrenheit)-->/)
  return m && m[1] === 'fahrenheit' ? 'fahrenheit' : 'celsius'
}

interface GeocodeHit {
  latitude: number
  longitude: number
  name: string
  country?: string
}

async function geocode(city: string, country: string): Promise<GeocodeHit | null> {
  const params = new URLSearchParams({
    name: city.trim(),
    count: '1',
    language: 'en',
    format: 'json',
  })
  if (country.trim()) params.set('country', country.trim())
  const url = `https://geocoding-api.open-meteo.com/v1/search?${params}`
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const json = (await res.json()) as { results?: GeocodeHit[] }
    return json.results?.[0] ?? null
  } catch (err) {
    console.warn('[weather] geocode failed', { city, country, err: String(err) })
    return null
  }
}

async function currentWeather(
  hit: GeocodeHit,
  units: 'celsius' | 'fahrenheit',
): Promise<{ temperature: number; weatherCode: number } | null> {
  const params = new URLSearchParams({
    latitude: String(hit.latitude),
    longitude: String(hit.longitude),
    current: 'temperature_2m,weather_code',
    temperature_unit: units,
  })
  const url = `https://api.open-meteo.com/v1/forecast?${params}`
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const json = (await res.json()) as {
      current?: { temperature_2m?: number; weather_code?: number }
    }
    const t = json.current?.temperature_2m
    const c = json.current?.weather_code
    if (typeof t !== 'number' || typeof c !== 'number') return null
    return { temperature: t, weatherCode: c }
  } catch (err) {
    console.warn('[weather] forecast failed', { hit, err: String(err) })
    return null
  }
}

async function resolveWeather(
  city: string,
  country: string,
  units: 'celsius' | 'fahrenheit',
): Promise<WeatherResolved | null> {
  if (!city) return null
  const hit = await geocode(city, country)
  if (!hit) return null
  const w = await currentWeather(hit, units)
  if (!w) return null
  const { emoji, summary } = weatherCodeToEmoji(w.weatherCode)
  const tempUnit = units === 'fahrenheit' ? '°F' : '°C'
  return {
    emoji,
    temp: `${Math.round(w.temperature)}${tempUnit}`,
    summary,
    location: `${hit.name}${hit.country ? `, ${hit.country}` : ''}`,
  }
}

const UNAVAILABLE_WEATHER: WeatherResolved = {
  emoji: '',
  temp: '',
  summary: WEATHER_UNAVAILABLE_SUMMARY,
  location: '',
}

function substituteWeather(html: string, w: WeatherResolved): string {
  return html
    .replace(/\{\{weather_emoji\}\}/g, w.emoji)
    .replace(/\{\{weather_temp\}\}/g, w.temp)
    .replace(/\{\{weather_summary\}\}/g, w.summary)
    .replace(/\{\{weather_location\}\}/g, w.location)
}

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

// Per drip-tick claim size. Bounds how many staggered recipients are
// dispatched each 60s dispatcher tick (drained over subsequent ticks).
const DRIP_LIMIT = 200

// Recipient merge fields usable in rich-text content as {{field}} or
// {{field|fallback text}}. `name` is derived from first + last. Values come
// from people.attributes and are HTML-escaped before substitution.
const MERGE_FIELDS = ['first_name', 'last_name', 'name', 'company', 'job_title'] as const
const MERGE_FIELD_GROUP = MERGE_FIELDS.join('|')

function htmlUsesMergeFields(html: string): boolean {
  return new RegExp(`\\{\\{\\s*(?:${MERGE_FIELD_GROUP})\\b`).test(html)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A fallback may be quoted to include punctuation/sentences and to preserve
 *  surrounding spaces, e.g. {{first_name|"Dan the man!"}}. Strip one layer of
 *  matching single/double quotes; otherwise trim. */
function unquoteFallback(fb: string): string {
  const t = fb.trim()
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * Substitute {{first_name}} / {{first_name|"fallback"}} merge tags from a
 * recipient's people.attributes, anywhere in the given text (body HTML, subject,
 * preheader, …). Missing/blank values use the inline fallback or empty string.
 * `escape` HTML-escapes values for HTML contexts; pass false for plain-text
 * contexts like the subject line (where &amp; etc. would show literally).
 */
function substituteMergeFields(text: string, attrs: Record<string, unknown>, escape = true): string {
  const re = new RegExp(`\\{\\{\\s*(${MERGE_FIELD_GROUP})\\s*(?:\\|([^}]*))?\\}\\}`, 'g')
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
  return text.replace(re, (_m, field: string, fallback?: string) => {
    let val: string
    if (field === 'name') {
      val = [str(attrs.first_name), str(attrs.last_name)].filter(Boolean).join(' ')
    } else {
      val = str(attrs[field])
    }
    if (!val) val = unquoteFallback(fallback ?? '')
    return escape ? escapeHtml(val) : val
  })
}

interface SendContext {
  html: string
  subject: string
  listId: string
  fromEmail: string
  fromName: string
  collectionReplyTo: string | null
  hmacSecret: string | undefined
  supabaseUrl: string
  // Portal origin (e.g. https://aaif.live) for the visible footer "manage your
  // subscriptions" link → the Subscription Centre. From the send metadata
  // (set by the admin at send-creation); null falls back to the edge-fn page.
  portalBaseUrl: string | null
  usesWeather: boolean
  weatherUnits: 'celsius' | 'fahrenheit'
  usesMergeFields: boolean
  // Full people.attributes per recipient email, loaded once when the content
  // uses weather or merge fields. Feeds both the weather city/country lookup
  // and merge-field substitution from a single query.
  attrsByEmail: Map<string, Record<string, unknown>>
  locationByEmail: Map<string, { city: string; country: string }>
  weatherCache: Map<string, WeatherResolved | null>
}

/**
 * Build everything needed to send an edition to one or more recipients:
 * collection Reply-To, link-tagged HTML, subject, list id, from, unsubscribe +
 * weather config. Shared by the all-at-once path (processSend) and the
 * per-recipient drip (runRecipientDrip) so both render identically. Throws on
 * missing HTML or list id (caller marks the send failed). Link tagging is
 * idempotent, so it's safe to rebuild per drip tick.
 */
async function buildSendContext(supabase: any, send: any, provider: EmailProviderModule): Promise<SendContext> {
  const collectionId: string | null = (send.edition as { collection_id?: string | null } | null)?.collection_id ?? null
  let collectionReplyTo: string | null = null
  if (collectionId) {
    const { data: coll } = await supabase
      .from('newsletters_template_collections')
      .select('reply_to')
      .eq('id', collectionId)
      .maybeSingle()
    collectionReplyTo = coll?.reply_to || null
  }

  let html = send.rendered_html as string
  if (!html) throw new Error('No rendered HTML found. Render the edition first.')

  try {
    const editionId = (send.edition as { id?: string } | null)?.id
    const trackingEnabled = collectionId == null ? true : await isLinkTrackingEnabled(supabase, collectionId)
    if (editionId && trackingEnabled) {
      const orderedRows = await syncEditionLinkRegistry(supabase, editionId)
      if (orderedRows.length > 0) html = tagHtmlLinks(html, orderedRows)
    }
  } catch (err) {
    console.warn('[newsletter-send] link tracking skipped:', err instanceof Error ? err.message : err)
  }

  const listId = (send.list_ids || [])[0]
  if (!listId) throw new Error('No subscription list configured for this send.')

  const usesWeather = /\{\{weather_(emoji|temp|summary|location)\}\}/.test(html)
  const subject = send.subject || send.edition?.subject || 'Newsletter'
  return {
    html,
    subject,
    listId,
    fromEmail: send.from_address || Deno.env.get('EMAIL_FROM') || 'noreply@localhost',
    fromName: send.from_name || Deno.env.get('EMAIL_FROM_NAME') || 'Gatewaze',
    collectionReplyTo,
    hmacSecret: Deno.env.get('UNSUBSCRIBE_HMAC_SECRET'),
    supabaseUrl: Deno.env.get('SUPABASE_URL')!,
    portalBaseUrl: ((send.metadata as { portal_base_url?: string } | null)?.portal_base_url) || Deno.env.get('SITE_URL') || null,
    usesWeather,
    weatherUnits: usesWeather ? extractWeatherUnits(html) : 'celsius',
    // Merge fields work in ANY email text — body HTML and the subject line.
    usesMergeFields: htmlUsesMergeFields(html) || htmlUsesMergeFields(subject),
    attrsByEmail: new Map(),
    locationByEmail: new Map(),
    weatherCache: new Map(),
  }
}

/** Bulk-load people.attributes for the given recipient emails into ctx — once,
 *  feeding both the weather city/country lookup and merge-field substitution.
 *  No-op unless the content actually uses weather or merge fields. */
async function loadRecipientAttributes(supabase: any, emails: string[], ctx: SendContext): Promise<void> {
  if (!ctx.usesWeather && !ctx.usesMergeFields) return
  const CHUNK = 500
  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK)
    const { data: peopleRows, error } = await supabase.from('people').select('email, attributes').in('email', chunk)
    if (error) { console.warn('[newsletter-send] people lookup failed:', error.message); break }
    for (const row of peopleRows ?? []) {
      const attrs = (row as { attributes?: Record<string, unknown> }).attributes ?? {}
      const rowEmail = (row as { email: string }).email
      ctx.attrsByEmail.set(rowEmail, attrs)
      if (ctx.usesWeather) {
        const city = typeof attrs.city === 'string' ? attrs.city : ''
        const country = typeof attrs.country === 'string' ? attrs.country : ''
        if (city) ctx.locationByEmail.set(rowEmail, { city, country })
      }
    }
  }
}

async function resolveWeatherFor(email: string, ctx: SendContext): Promise<WeatherResolved> {
  if (!ctx.usesWeather) return UNAVAILABLE_WEATHER
  const loc = ctx.locationByEmail.get(email)
  if (!loc) return UNAVAILABLE_WEATHER
  const key = `${loc.city.toLowerCase()}|${loc.country.toLowerCase()}|${ctx.weatherUnits}`
  if (ctx.weatherCache.has(key)) return ctx.weatherCache.get(key) ?? UNAVAILABLE_WEATHER
  const w = await resolveWeather(loc.city, loc.country, ctx.weatherUnits)
  ctx.weatherCache.set(key, w)
  return w ?? UNAVAILABLE_WEATHER
}

/**
 * Send the edition to a single recipient: unsubscribe header, weather
 * substitution, email_send_log row, provider call, log update. Returns true on
 * success (never throws) so both the batch path and the drip can tally simply.
 */
async function sendToRecipient(supabase: any, provider: EmailProviderModule, ctx: SendContext, sendId: string, email: string): Promise<boolean> {
  try {
    // Two unsubscribe URLs from the same signed token:
    //  • oneClickUrl → the edge fn, used for the RFC 8058 List-Unsubscribe
    //    header (must be a single-POST, no landing page).
    //  • prefsUrl → the portal Subscription Centre, the VISIBLE footer link,
    //    where the recipient sees every list and unsubscribes per-list. Falls
    //    back to the one-click edge-fn page when no portal base is known.
    // Three URLs from one signed token:
    //  • oneClickUrl → edge fn, for the RFC 8058 List-Unsubscribe header.
    //  • unsubUrl    → Subscription Centre that ALSO unsubscribes this list on
    //                  arrival (the visible "Unsubscribe" link / {{unsubscribe_url}}).
    //  • manageUrl   → full Subscription Centre, no auto-unsubscribe
    //                  ("Manage preferences" / {{manage_subscriptions_url}}).
    // unsub/manage fall back to the one-click edge-fn page when no portal base.
    let oneClickUrl = ''
    let unsubUrl = ''
    let manageUrl = ''
    let emailHeaders: Record<string, string> = {}
    if (ctx.hmacSecret) {
      const token = await generateUnsubscribeToken(email, ctx.listId, ctx.hmacSecret)
      const tok = encodeURIComponent(token)
      oneClickUrl = `${ctx.supabaseUrl}/functions/v1/newsletter-unsubscribe?token=${tok}`
      const base = ctx.portalBaseUrl ? ctx.portalBaseUrl.replace(/\/$/, '') : null
      manageUrl = base ? `${base}/subscriptions?token=${tok}` : oneClickUrl
      unsubUrl = base ? `${base}/subscriptions?token=${tok}&unsub=1` : oneClickUrl
      emailHeaders = {
        'List-Unsubscribe': `<${oneClickUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }
    }

    let personalizedHtml = ctx.html
    if (unsubUrl) {
      const hadPlaceholder = /\{\{unsubscribe_url\}\}/.test(ctx.html)
      personalizedHtml = personalizedHtml
        .replace(/\{\{unsubscribe_url\}\}/g, unsubUrl)
        .replace(/\{\{manage_subscriptions_url\}\}/g, manageUrl)
      if (!hadPlaceholder) {
        personalizedHtml = personalizedHtml.replace(
          '</body>',
          `<div style="text-align:center;padding:20px;font-size:12px;color:#999;">` +
            `<a href="${unsubUrl}" style="color:#999;">Unsubscribe</a> &middot; ` +
            `<a href="${manageUrl}" style="color:#999;">Manage your email preferences</a>` +
            `</div></body>`,
        )
      }
    }

    if (ctx.usesWeather) {
      personalizedHtml = substituteWeather(personalizedHtml, await resolveWeatherFor(email, ctx))
    }

    // Merge fields apply to any text in the email: the body HTML (escaped) and
    // the subject line (plain text, not escaped).
    let subject = ctx.subject
    if (ctx.usesMergeFields) {
      const attrs = ctx.attrsByEmail.get(email) ?? {}
      personalizedHtml = substituteMergeFields(personalizedHtml, attrs, true)
      subject = substituteMergeFields(ctx.subject, attrs, false)
    }

    const { data: logEntry } = await supabase.from('email_send_log').insert({
      recipient_email: email,
      from_address: ctx.fromEmail,
      reply_to: ctx.collectionReplyTo,
      subject,
      content_html: personalizedHtml,
      provider: provider.name,
      newsletter_send_id: sendId,
      status: 'queued',
      queued_at: new Date().toISOString(),
    }).select('id').single()

    const result = await provider.send({
      to: email,
      from: ctx.fromEmail,
      fromName: ctx.fromName,
      ...(ctx.collectionReplyTo ? { replyTo: ctx.collectionReplyTo } : {}),
      subject,
      html: personalizedHtml,
      headers: emailHeaders,
      // We own the unsubscribe footer (→ Subscription Centre) + the
      // List-Unsubscribe header, so suppress the provider's auto-appended one.
      disableSubscriptionTracking: true,
    })

    if (result.success) {
      await supabase.from('email_send_log').update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        provider_message_id: result.messageId || null,
        send_attempts: 1,
      }).eq('id', logEntry?.id)
      return true
    }
    await supabase.from('email_send_log').update({
      status: result.retryable ? 'send_failed' : 'permanently_failed',
      failure_error: result.error,
      send_attempts: 1,
    }).eq('id', logEntry?.id)
    return false
  } catch (err) {
    console.error('[newsletter-send] recipient failed:', email, err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Fan out a staggered (tz_local / personalised) send into the per-recipient
 * timing queue (each recipient's send_at = target_local in their own timezone)
 * and flip the send to 'sending'. The drip then dispatches due rows over time.
 */
async function fanOutAndStart(supabase: any, sendId: string): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase.rpc('fanout_newsletter_send_recipients', { p_send_id: sendId })
  if (error) {
    await supabase.from('newsletter_sends').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', sendId)
    return { success: false, error: error.message }
  }
  await supabase.from('newsletter_sends').update({
    status: 'sending',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', sendId)
  return { success: true }
}

/** Recompute a staggered send's counters from its recipient queue and finalise
 *  when nothing is left to dispatch. forceCancel finalises it as 'cancelled'. */
async function recomputeAndMaybeFinalize(supabase: any, sendId: string, forceCancel = false): Promise<void> {
  const headCount = async (statuses: string[]): Promise<number> => {
    const { count } = await supabase
      .from('newsletter_send_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('send_id', sendId)
      .in('status', statuses)
    return count ?? 0
  }
  const [remaining, sent, failed] = await Promise.all([
    headCount(['pending', 'sending']),
    headCount(['sent']),
    headCount(['failed']),
  ])
  const patch: Record<string, unknown> = { sent_count: sent, failed_count: failed, updated_at: new Date().toISOString() }
  if (remaining === 0) {
    patch.status = forceCancel ? 'cancelled' : (sent === 0 && failed > 0 ? 'failed' : 'sent')
    patch.completed_at = new Date().toISOString()
  }
  await supabase.from('newsletter_sends').update(patch).eq('id', sendId)
}

/**
 * One drip pass: claim due recipients across all staggered sends, dispatch
 * them, mark each row, then refresh counters / finalise. A send the operator
 * has stopped ('cancelling') has its claimed rows skipped instead of sent.
 */
async function runRecipientDrip(supabase: any, provider: EmailProviderModule): Promise<void> {
  const { data: claimed, error } = await supabase.rpc('claim_due_newsletter_recipients', { p_limit: DRIP_LIMIT })
  if (error) console.error('[drip] claim failed:', error.message)

  const bySend = new Map<string, Array<{ id: string; email: string }>>()
  for (const r of claimed ?? []) {
    if (!bySend.has(r.send_id)) bySend.set(r.send_id, [])
    bySend.get(r.send_id)!.push({ id: r.id, email: r.email })
  }

  for (const [sendId, recips] of bySend) {
    const { data: send } = await supabase
      .from('newsletter_sends')
      .select('*, edition:newsletters_editions(*)')
      .eq('id', sendId)
      .single()
    if (!send) continue
    if (send.status === 'cancelling' || send.status === 'cancelled') {
      await supabase.from('newsletter_send_recipients')
        .update({ status: 'skipped', updated_at: new Date().toISOString() })
        .in('id', recips.map((r) => r.id))
      continue
    }
    let ctx: SendContext
    try {
      ctx = await buildSendContext(supabase, send, provider)
    } catch (err) {
      // Couldn't build context (e.g. no rendered HTML) — release the rows back
      // to pending so a later tick can retry rather than dropping recipients.
      await supabase.from('newsletter_send_recipients')
        .update({ status: 'pending', last_error: err instanceof Error ? err.message : 'context build failed', updated_at: new Date().toISOString() })
        .in('id', recips.map((r) => r.id))
      continue
    }
    await loadRecipientAttributes(supabase, recips.map((r) => r.email), ctx)
    for (let i = 0; i < recips.length; i += BATCH_SIZE) {
      const slice = recips.slice(i, i + BATCH_SIZE)
      const results = await Promise.allSettled(
        slice.map((r) => sendToRecipient(supabase, provider, ctx, sendId, r.email).then((ok) => ({ id: r.id, ok }))),
      )
      for (const res of results) {
        if (res.status === 'fulfilled') {
          await supabase.from('newsletter_send_recipients')
            .update({ status: res.value.ok ? 'sent' : 'failed', updated_at: new Date().toISOString() })
            .eq('id', res.value.id)
        }
      }
      if (i + BATCH_SIZE < recips.length) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
    }
  }

  // Refresh counters + finalise every in-flight staggered send — covers ticks
  // where the last recipients just sent, and propagates operator stops.
  const { data: active } = await supabase
    .from('newsletter_sends')
    .select('id, status')
    .in('status', ['sending', 'cancelling'])
    .neq('delivery_strategy', 'global')
  for (const s of active ?? []) {
    if (s.status === 'cancelling') {
      await supabase.from('newsletter_send_recipients')
        .update({ status: 'skipped', updated_at: new Date().toISOString() })
        .eq('send_id', s.id)
        .in('status', ['pending', 'sending'])
      await recomputeAndMaybeFinalize(supabase, s.id, true)
    } else {
      await recomputeAndMaybeFinalize(supabase, s.id)
    }
  }
}

async function processScheduledSends(
  supabase: any,
  provider: EmailProviderModule
): Promise<{ success: boolean; processed: number; errors: string[] }> {
  const { data: sends, error } = await supabase
    .from('newsletter_sends')
    .select('id, delivery_strategy')
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
    const strategy = send.delivery_strategy || 'global'
    if (strategy === 'global') {
      // All-at-once: send everyone now.
      const result = await processSend(supabase, send.id, provider)
      if (result.success) processed++
      else errors.push(`Send ${send.id}: ${result.error}`)
    } else {
      // tz_local / personalised: fan out into the per-recipient timing queue
      // and flip to 'sending'; the drip below dispatches each as it comes due.
      const r = await fanOutAndStart(supabase, send.id)
      if (r.success) processed++
      else errors.push(`Send ${send.id}: ${r.error}`)
    }
  }

  // Drive the per-recipient drip every tick — independent of newly-due sends,
  // so an in-progress staggered send keeps dispatching as each timezone hits
  // its local send time.
  await runRecipientDrip(supabase, provider)

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
    const ctx = await buildSendContext(supabase, send, provider)

    const { data: subscribers, error: subError } = await supabase
      .from('list_subscriptions')
      .select('email')
      .eq('list_id', ctx.listId)
      .eq('subscribed', true)

    if (subError) throw new Error(`Failed to fetch subscribers: ${subError.message}`)

    let recipientEmails: string[] = (subscribers || []).map((s: any) => s.email)

    // Exclude recipients already successfully sent in one or more prior sends
    // (re-send corrected content without double-sending). Matched on the
    // email_send_log 'sent' rows those sends wrote. Staggered sends apply the
    // same exclusion in SQL at fan-out time (migration 044).
    const excludeIds = (send.exclude_sent_send_ids as string[] | null) ?? null
    if (excludeIds && excludeIds.length > 0) {
      const { data: sentRows } = await supabase
        .from('email_send_log')
        .select('recipient_email')
        .in('newsletter_send_id', excludeIds)
        .eq('status', 'sent')
      const alreadySent = new Set((sentRows ?? []).map((r: any) => String(r.recipient_email).toLowerCase()))
      if (alreadySent.size > 0) {
        recipientEmails = recipientEmails.filter((e) => !alreadySent.has(e.toLowerCase()))
      }
    }

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

    await loadRecipientAttributes(supabase, recipientEmails, ctx)
    let delivered = 0
    let failed = 0

    for (let i = 0; i < recipientEmails.length; i += BATCH_SIZE) {
      // Cooperative cancellation: the operator can request a stop mid-send
      // (the UI sets status='cancelling'). Re-read the row before each batch
      // and bail cleanly, recording what was already delivered. Cheap — one
      // indexed lookup per BATCH_SIZE recipients.
      const { data: cur } = await supabase
        .from('newsletter_sends')
        .select('status')
        .eq('id', sendId)
        .single()
      if (cur && (cur.status === 'cancelling' || cur.status === 'cancelled')) {
        await supabase
          .from('newsletter_sends')
          .update({
            status: 'cancelled',
            completed_at: new Date().toISOString(),
            sent_count: delivered,
            failed_count: failed,
            updated_at: new Date().toISOString(),
          })
          .eq('id', sendId)
        console.log(`[newsletter-send] send ${sendId} cancelled mid-flight after ${delivered} delivered`)
        return { success: true, delivered, failed }
      }

      const batch = recipientEmails.slice(i, i + BATCH_SIZE)
      const results = await Promise.allSettled(
        batch.map((email: string) => sendToRecipient(supabase, provider, ctx, sendId, email)),
      )

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) delivered++
        else failed++
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
