// @ts-nocheck — Deno edge function
/**
 * calendars-inbound-email
 *
 * Receives SendGrid Inbound Parse webhooks for the calendar email group
 * domain. The webhook posts multipart/form-data containing the parsed
 * email. This function:
 *
 *   1. Parses the `to` address(es) to find the `{slug}@{domain}` form
 *   2. Resolves the calendar by slug
 *   3. Looks up the active admin emails for that calendar
 *   4. Fans out a forwarded copy via the existing `email-send` function,
 *      preserving subject/body and setting the Reply-To back to the group
 *      address so replies loop through
 *   5. Logs every inbound to `calendar_email_forwards` for auditing
 *
 * SendGrid Inbound Parse setup (do once per brand):
 *   - Add MX record: `{EMAIL_FROM_DOMAIN}` → `mx.sendgrid.net` (priority 10)
 *   - In SendGrid → Settings → Inbound Parse → Add Host & URL
 *       Receiving domain: {EMAIL_FROM_DOMAIN}
 *       Destination URL:  https://<project>.supabase.co/functions/v1/calendars-inbound-email
 *       POST the raw MIME message: NO (parsed fields only)
 *       Check incoming emails for spam: YES
 *
 * Per spec-calendars-microsites.md (calendar email groups feature).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
// The domain for calendar group addresses. Defaults to the domain part of
// EMAIL_FROM if set, otherwise explicitly via CALENDAR_EMAIL_DOMAIN.
const EMAIL_FROM = Deno.env.get('EMAIL_FROM') || ''
const EMAIL_FROM_NAME = Deno.env.get('EMAIL_FROM_NAME') || ''
const EXPLICIT_DOMAIN = Deno.env.get('CALENDAR_EMAIL_DOMAIN') || ''

function getDomain(): string {
  if (EXPLICIT_DOMAIN) return EXPLICIT_DOMAIN.toLowerCase()
  const at = EMAIL_FROM.indexOf('@')
  if (at > 0) return EMAIL_FROM.substring(at + 1).toLowerCase()
  return ''
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
}

interface ParsedInbound {
  to: string
  from: string
  fromName: string | null
  subject: string
  text: string
  html: string
  messageId: string | null
  rawSize: number
}

/**
 * Parse a SendGrid Inbound Parse multipart/form-data request.
 * SendGrid posts parsed fields like `to`, `from`, `subject`, `text`, `html`,
 * `headers`, `email` (raw MIME if enabled) as form fields.
 */
async function parseInbound(req: Request): Promise<ParsedInbound | null> {
  const contentType = req.headers.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data') && !contentType.startsWith('application/x-www-form-urlencoded')) {
    return null
  }

  const form = await req.formData()
  const to = (form.get('to') || '').toString()
  const fromRaw = (form.get('from') || '').toString()
  const subject = (form.get('subject') || '').toString()
  const text = (form.get('text') || '').toString()
  const html = (form.get('html') || '').toString()
  const headers = (form.get('headers') || '').toString()

  // Parse "Name <email@example.com>" format
  let fromEmail = fromRaw
  let fromName: string | null = null
  const match = fromRaw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/)
  if (match) {
    fromName = match[1].trim() || null
    fromEmail = match[2].trim()
  }

  // Extract Message-ID from headers blob
  let messageId: string | null = null
  const midMatch = headers.match(/^Message-ID:\s*(.+)$/mi)
  if (midMatch) messageId = midMatch[1].trim()

  // Raw size approximation
  const rawSize = (form.get('email')?.toString().length || 0) + text.length + html.length

  return {
    to,
    from: fromEmail,
    fromName,
    subject,
    text,
    html,
    messageId,
    rawSize,
  }
}

/**
 * Pick the slug from a "to" field which may contain multiple addresses and
 * formatting. Returns the first address that matches `{slug}@{domain}`.
 */
function extractSlug(toField: string, domain: string): string | null {
  // to may look like: "Berlin Chapter <berlin-chapter@app.example.com>, other@x.com"
  const addresses = toField.split(/[,;]/).map((s) => s.trim())
  for (const addr of addresses) {
    const m = addr.match(/<?([a-zA-Z0-9._-]+)@([^>\s]+)>?/)
    if (!m) continue
    const local = m[1].toLowerCase()
    const host = m[2].toLowerCase()
    if (host === domain || host.endsWith('.' + domain)) {
      return local
    }
  }
  return null
}

/**
 * Forward one message to a list of admin recipients by invoking email-send
 * once per recipient. We use BCC to fan out individually so recipients
 * don't see each other's addresses.
 */
async function forwardToAdmins(args: {
  calendar: { id: string; name: string; slug: string }
  parsed: ParsedInbound
  adminEmails: string[]
  groupAddress: string
}): Promise<{ sent: number; errors: string[] }> {
  const { calendar, parsed, adminEmails, groupAddress } = args
  const errors: string[] = []
  let sent = 0

  const fromName = EMAIL_FROM_NAME
    ? `${calendar.name} via ${EMAIL_FROM_NAME}`
    : calendar.name

  // Wrap the original subject with a clear prefix
  const subject = `[${calendar.name}] ${parsed.subject || '(no subject)'}`

  // Add a header block at the top of the forwarded content showing the
  // original sender, so admins can see who the message is really from.
  const senderLabel = parsed.fromName
    ? `${parsed.fromName} <${parsed.from}>`
    : parsed.from

  const headerHtml = `
<div style="background:#f6f6f8;border:1px solid #e4e4e7;border-radius:8px;padding:12px 16px;margin:0 0 16px;font-family:-apple-system,sans-serif;font-size:13px;color:#52525b;">
  <div><strong>From:</strong> ${escapeHtml(senderLabel)}</div>
  <div><strong>Sent to:</strong> ${escapeHtml(groupAddress)} (${escapeHtml(calendar.name)} group)</div>
</div>
`

  const headerText = `
From: ${senderLabel}
Sent to: ${groupAddress} (${calendar.name} group)
--------
`

  const html = parsed.html ? headerHtml + parsed.html : ''
  const text = parsed.text ? headerText + parsed.text : ''

  for (const recipient of adminEmails) {
    try {
      const { error } = await supabase.functions.invoke('email-send', {
        body: {
          to: recipient,
          from: groupAddress,
          fromName,
          replyTo: groupAddress,
          subject,
          html: html || undefined,
          text: text || '(no content)',
        },
      })
      if (error) {
        errors.push(`${recipient}: ${error.message || 'unknown'}`)
        continue
      }
      sent++
    } catch (e: any) {
      errors.push(`${recipient}: ${e?.message || String(e)}`)
    }
  }

  return { sent, errors }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }

  const domain = getDomain()
  if (!domain) {
    console.error('[calendars-inbound-email] No domain configured. Set EMAIL_FROM or CALENDAR_EMAIL_DOMAIN.')
    return new Response('Server misconfigured', { status: 500, headers: corsHeaders })
  }

  let parsed: ParsedInbound | null
  try {
    parsed = await parseInbound(req)
  } catch (e: any) {
    console.error('[calendars-inbound-email] Failed to parse request:', e)
    return new Response('Bad request', { status: 400, headers: corsHeaders })
  }
  if (!parsed) {
    return new Response('Unsupported content type', { status: 415, headers: corsHeaders })
  }

  console.log(
    `[calendars-inbound-email] received to=${parsed.to} from=${parsed.from} subject="${parsed.subject}"`
  )

  // Extract the slug
  const slug = extractSlug(parsed.to, domain)
  if (!slug) {
    console.warn('[calendars-inbound-email] no matching {slug}@domain in to field')
    await supabase.from('calendar_email_forwards').insert({
      calendar_id: null,
      to_address: parsed.to,
      from_address: parsed.from,
      from_name: parsed.fromName,
      subject: parsed.subject,
      message_id: parsed.messageId,
      status: 'rejected',
      error_message: 'no matching {slug}@domain in recipient',
      raw_size_bytes: parsed.rawSize,
    })
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  const groupAddress = `${slug}@${domain}`

  // Resolve the calendar
  const { data: calRows, error: calErr } = await supabase.rpc('resolve_calendar_by_slug_or_id', {
    p_identifier: slug,
  })

  const calendar = Array.isArray(calRows) && calRows.length > 0 ? calRows[0] : null

  if (calErr || !calendar || !calendar.is_active) {
    console.warn(`[calendars-inbound-email] no active calendar found for slug=${slug}`)
    await supabase.from('calendar_email_forwards').insert({
      calendar_id: calendar?.id || null,
      to_address: groupAddress,
      from_address: parsed.from,
      from_name: parsed.fromName,
      subject: parsed.subject,
      message_id: parsed.messageId,
      status: 'no_calendar',
      error_message: calErr?.message || 'calendar not found or inactive',
      raw_size_bytes: parsed.rawSize,
    })
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  // Honour the opt-out flag
  const settings = (calendar.settings || {}) as Record<string, unknown>
  if (settings.email_group_enabled === false) {
    console.warn(`[calendars-inbound-email] calendar ${slug} has email groups disabled`)
    await supabase.from('calendar_email_forwards').insert({
      calendar_id: calendar.id,
      to_address: groupAddress,
      from_address: parsed.from,
      from_name: parsed.fromName,
      subject: parsed.subject,
      message_id: parsed.messageId,
      status: 'disabled',
      raw_size_bytes: parsed.rawSize,
    })
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  // Resolve the admin email list
  const { data: adminRows } = await supabase.rpc('get_calendar_admin_emails', {
    p_calendar_id: calendar.id,
  })

  const adminEmails: string[] = ((adminRows || []) as Array<{ admin_id: string; email: string }>)
    .map((r) => r.email)
    .filter(Boolean)

  if (adminEmails.length === 0) {
    console.warn(`[calendars-inbound-email] calendar ${slug} has no admins with email addresses`)
    await supabase.from('calendar_email_forwards').insert({
      calendar_id: calendar.id,
      to_address: groupAddress,
      from_address: parsed.from,
      from_name: parsed.fromName,
      subject: parsed.subject,
      message_id: parsed.messageId,
      status: 'no_admins',
      raw_size_bytes: parsed.rawSize,
    })
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  // Forward to all admins
  const result = await forwardToAdmins({
    calendar: { id: calendar.id, name: calendar.name, slug: calendar.slug || calendar.calendar_id },
    parsed,
    adminEmails,
    groupAddress,
  })

  // Log the forward
  await supabase.from('calendar_email_forwards').insert({
    calendar_id: calendar.id,
    to_address: groupAddress,
    from_address: parsed.from,
    from_name: parsed.fromName,
    subject: parsed.subject,
    message_id: parsed.messageId,
    recipient_count: result.sent,
    recipients: adminEmails,
    status: result.sent > 0 ? 'forwarded' : 'failed',
    error_message: result.errors.length > 0 ? result.errors.join('; ') : null,
    raw_size_bytes: parsed.rawSize,
  })

  console.log(`[calendars-inbound-email] ${slug}: forwarded to ${result.sent}/${adminEmails.length} admins`)

  return new Response(
    JSON.stringify({
      sent: result.sent,
      errors: result.errors,
      calendar: slug,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

Deno.serve(handler)
