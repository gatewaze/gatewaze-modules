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

  // Collection-level Reply-To: when the operator wants outbound mail to
  // appear from one address but replies to land at another (common when
  // sending from a branded sub-domain — e.g. demetrios@news.mlops.community
  // — but routing replies to a unified inbox like demetrios@aaif.live).
  // newsletter_sends doesn't carry reply_to of its own; pull it off the
  // collection and forward to the provider via the existing replyTo
  // hook. Persist on email_send_log too so email-retry-send (which reads
  // log.reply_to) keeps the header on retries.
  let collectionReplyTo: string | null = null
  const collectionId: string | null = (send.edition as { collection_id?: string | null } | null)?.collection_id ?? null
  if (collectionId) {
    const { data: coll } = await supabase
      .from('newsletters_template_collections')
      .select('reply_to')
      .eq('id', collectionId)
      .maybeSingle()
    collectionReplyTo = coll?.reply_to || null
  }

  if (!['scheduled', 'draft', 'sending'].includes(send.status)) {
    return { success: false, delivered: 0, failed: 0, error: `Send is in ${send.status} state` }
  }

  await supabase
    .from('newsletter_sends')
    .update({ status: 'sending', updated_at: new Date().toISOString() })
    .eq('id', sendId)

  try {
    let html = send.rendered_html as string
    if (!html) {
      throw new Error('No rendered HTML found. Render the edition first.')
    }

    // ── Block-level click tracking ──────────────────────────────────────────
    // Sync the per-occurrence link registry for this edition and rewrite the
    // base HTML so each tracked link carries ?nlb=<tracking_key>. Done once
    // (keys are per-link, not per-recipient) before personalisation. Wrapped so
    // any failure falls back to an untagged send (deliverability over tracking).
    // See spec-newsletter-link-tracking.md §4.3.
    try {
      const editionId = (send.edition as { id?: string } | null)?.id
      const trackingEnabled =
        collectionId == null ? true : await isLinkTrackingEnabled(supabase, collectionId)
      if (editionId && trackingEnabled) {
        const orderedRows = await syncEditionLinkRegistry(supabase, editionId)
        if (orderedRows.length > 0) html = tagHtmlLinks(html, orderedRows)
      }
    } catch (err) {
      console.warn('[newsletter-send] link tracking skipped:', err instanceof Error ? err.message : err)
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

    // Detect the Weather block before paying for the per-recipient
    // city/country lookup — most editions won't use it.
    const usesWeather = /\{\{weather_(emoji|temp|summary|location)\}\}/.test(html)
    const weatherUnits = usesWeather ? extractWeatherUnits(html) : 'celsius'

    // Bulk-load recipient location attributes. people.email is unique
    // and indexed (00003_people.sql); city/country live under
    // attributes->>'city' / attributes->>'country' (jsonb).
    const locationByEmail = new Map<string, { city: string; country: string }>()
    if (usesWeather) {
      // Supabase JS caps a single .in() payload at a few thousand rows;
      // chunk to be safe across very large lists.
      const CHUNK = 500
      for (let i = 0; i < recipientEmails.length; i += CHUNK) {
        const chunk = recipientEmails.slice(i, i + CHUNK)
        const { data: peopleRows, error: pErr } = await supabase
          .from('people')
          .select('email, attributes')
          .in('email', chunk)
        if (pErr) {
          console.warn('[weather] people lookup failed; falling back to unavailable', pErr.message)
          break
        }
        for (const row of peopleRows ?? []) {
          const attrs = (row as { attributes?: Record<string, unknown> }).attributes ?? {}
          const city = typeof attrs.city === 'string' ? attrs.city : ''
          const country = typeof attrs.country === 'string' ? attrs.country : ''
          if (city) {
            locationByEmail.set((row as { email: string }).email, { city, country })
          }
        }
      }
    }

    for (let i = 0; i < recipientEmails.length; i += BATCH_SIZE) {
      const batch = recipientEmails.slice(i, i + BATCH_SIZE)

      const fromEmail = send.from_address || Deno.env.get('EMAIL_FROM') || 'noreply@localhost'
      const fromName = send.from_name || Deno.env.get('EMAIL_FROM_NAME') || 'Gatewaze'

      // Per-batch open-meteo cache — duplicate locations within a batch
      // share a single resolution. Cached `null` means we already tried
      // and failed (don't retry within the batch).
      const weatherCache = new Map<string, WeatherResolved | null>()
      async function getWeatherForEmail(email: string): Promise<WeatherResolved> {
        if (!usesWeather) return UNAVAILABLE_WEATHER
        const loc = locationByEmail.get(email)
        if (!loc) return UNAVAILABLE_WEATHER
        const key = `${loc.city.toLowerCase()}|${loc.country.toLowerCase()}|${weatherUnits}`
        if (weatherCache.has(key)) {
          return weatherCache.get(key) ?? UNAVAILABLE_WEATHER
        }
        const w = await resolveWeather(loc.city, loc.country, weatherUnits)
        weatherCache.set(key, w)
        return w ?? UNAVAILABLE_WEATHER
      }

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

          if (usesWeather) {
            const weather = await getWeatherForEmail(email)
            personalizedHtml = substituteWeather(personalizedHtml, weather)
          }

          // Create email_send_log entry
          const { data: logEntry } = await supabase.from('email_send_log').insert({
            recipient_email: email,
            from_address: fromEmail,
            reply_to: collectionReplyTo,
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
            ...(collectionReplyTo ? { replyTo: collectionReplyTo } : {}),
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
