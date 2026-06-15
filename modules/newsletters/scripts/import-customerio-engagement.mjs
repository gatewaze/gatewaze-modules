#!/usr/bin/env node
// Customer.io historical engagement import.
// Spec: spec-newsletter-personalised-delivery.md §7 (Part D) + §6 (Part C).
//
// Loads the local Customer.io backups (no live API needed — the account may be
// suspended) and backfills gatewaze engagement:
//   • activities/*  (raw open/click events w/ UA/IP + prefetched/proxied flags)
//       → email_events (source='customer.io') + email_event_classifications
//         (detection_source='customer.io', is_human = !(prefetched|proxied))
//   • per-recipient first open/click + delivery → email_send_log
//   • one synthetic newsletter_sends row per CIO weekly newsletter, linked to the
//     gatewaze edition with the same edition_date in the target collection.
//
// Mapping chain: activity.data.template_id  ──┐
//   weekly-index.json: date → CIO newsletter id, content_ids
//   newsletters/<id>/messages.json: msg_template_id → newsletter_id
//   → newsletter id → edition_date → gatewaze edition (by date, in collection)
//
// Idempotent: re-links each weekly to the CURRENT edition by date, sweeps any
// customer.io rows orphaned by edition-id churn (editions recreated with new ids
// cascade-delete the synthetic send, leaving dangling send_log/events), and per
// send deletes prior source='customer.io' rows before reloading.
// DRY-RUN by default; pass --apply to write.
//
// Usage:
//   SUPABASE_URL=http://127.0.0.1:54331 SUPABASE_SERVICE_ROLE_KEY=... \
//   node import-customerio-engagement.mjs \
//     [--content-backup DIR] [--raw-backup DIR] [--collection-slug usercommunity] \
//     [--limit-newsletters N] [--apply]

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ── args / env ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return def
  const v = args[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const CONTENT_DIR = flag('content-backup', '/Users/dan/Git/gatewaze/cio-customerio-backup')
const RAW_DIR = flag('raw-backup', '/Users/dan/Git/gatewaze/cio-backup')
const COLLECTION_SLUG = flag('collection-slug', 'usercommunity')
const LIMIT_NL = flag('limit-newsletters', null)
const ONLY_NL = flag('only-newsletter', null) // CIO newsletter id — import just this one
const APPLY = args.includes('--apply')

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '')
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.')
  process.exit(1)
}

// ── tiny REST client ────────────────────────────────────────────────────────
const H = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
}
async function rest(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { ...H, ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`${method} ${path} → ${res.status}: ${t.slice(0, 300)}`)
  }
  const txt = await res.text()
  return txt ? JSON.parse(txt) : null
}

// Exact row count via PostgREST's Content-Range header (cheap; Range 0-0).
async function countRows(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'GET',
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' },
  })
  const total = (res.headers.get('content-range') || '').split('/')[1]
  return total && total !== '*' ? Number(total) : 0
}

// ── orphan GC ────────────────────────────────────────────────────────────────
// We map each weekly to the CURRENT edition for its date (editionByDate), so the
// import already re-links to whichever edition exists now. But editions are
// recreated with NEW ids by the content-migration tooling, which cascade-deletes
// the synthetic newsletter_sends row — and email_send_log / email_events have no
// FK back to the send, so those rows are left dangling (newsletter_send_id points
// at a deleted send). Without cleanup, a re-run just inserts a fresh set
// alongside the dead ones, accumulating bloat each churn. This removes any
// customer.io-sourced row whose send no longer exists, keeping re-runs idempotent.
const GC_SQL = `
DELETE FROM public.email_event_classifications c
USING public.email_events e
WHERE c.event_id = e.id
  AND e.source = 'customer.io'
  AND NOT EXISTS (SELECT 1 FROM public.newsletter_sends s WHERE s.id = e.newsletter_send_id);
DELETE FROM public.email_events e
WHERE e.source = 'customer.io'
  AND NOT EXISTS (SELECT 1 FROM public.newsletter_sends s WHERE s.id = e.newsletter_send_id);
DELETE FROM public.email_send_log l
WHERE l.provider = 'customer.io'
  AND NOT EXISTS (SELECT 1 FROM public.newsletter_sends s WHERE s.id = l.newsletter_send_id);
`
async function gcOrphans() {
  const logBefore = await countRows('email_send_log?provider=eq.customer.io')
  const evBefore = await countRows('email_events?source=eq.customer.io')
  await rest('rpc/exec_sql', { method: 'POST', body: { sql_text: GC_SQL } })
  const logAfter = await countRows('email_send_log?provider=eq.customer.io')
  const evAfter = await countRows('email_events?source=eq.customer.io')
  console.log(
    `[import] orphan GC: removed ${logBefore - logAfter} send_log + ${evBefore - evAfter} events ` +
      `(dangling after edition-id churn); kept ${logAfter} send_log + ${evAfter} events`,
  )
}

// ── event type mapping ──────────────────────────────────────────────────────
const TYPE_MAP = {
  opened_email: 'opened',
  clicked_email: 'clicked',
  delivered_email: 'delivered',
  sent_email: 'sent',
  bounced_email: 'bounced',
  dropped_email: 'bounced',
  spammed_email: 'spammed',
  unsubscribed: 'unsubscribed',
  unsubscribed_email: 'unsubscribed',
}

const isoFromUnix = (s) => (typeof s === 'number' ? new Date(s * 1000).toISOString() : null)

// Customer.io's own authoritative per-newsletter metrics (from the metrics
// endpoint), incl. its human/machine open split — far more accurate than our
// raw prefetched/proxied heuristic, so these become the displayed numbers
// (the spec's "trusted source"). Sums the daily series.
function loadCioMetrics(nlId) {
  const p = join(RAW_DIR, 'newsletters', String(nlId), 'metrics.json')
  if (!existsSync(p)) return null
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'))
    const series = d?.metric?.series || {}
    const sum = (k) => (Array.isArray(series[k]) ? series[k].reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0) : 0)
    const opened = sum('opened')
    const human_opened = sum('human_opened')
    return {
      sent: sum('sent'),
      delivered: sum('delivered'),
      bounced: sum('bounced'),
      opened,
      human_opened,
      machine_opened: Math.max(0, opened - human_opened),
      prefetch_opened: sum('prefetch_opened'),
      clicked: sum('clicked'),
      human_clicked: sum('human_clicked'),
      machine_clicked: sum('machine_clicked'),
      unsubscribed: sum('unsubscribed'),
      spammed: sum('spammed'),
      suppressed: sum('suppressed'),
    }
  } catch {
    return null
  }
}

// ── load mappings from the content backup ───────────────────────────────────
function loadWeeklyIndex() {
  const idx = JSON.parse(readFileSync(join(CONTENT_DIR, 'weekly-index.json'), 'utf8'))
  // { 'YYYY-MM-DD': { id, content_ids, name, sent_at, ... } }
  const byNewsletterId = new Map()
  for (const [date, e] of Object.entries(idx)) {
    byNewsletterId.set(Number(e.id), { date, name: e.name, contentIds: e.content_ids || [], sentAt: e.sent_at })
  }
  return byNewsletterId
}

// Build delivery_id → newsletterId from each weekly newsletter's complete
// messages (messages-full.json, re-pulled). A CIO message id IS the delivery_id
// that appears on every open/click activity, so this is the authoritative
// per-delivery routing. (template_id is a shared CIO Template — useless here.)
// Falls back to the capped messages.json if a full pull isn't present.
function buildDeliveryMap(weekly) {
  const deliveryToNl = new Map()
  let withFull = 0
  for (const [nlId] of weekly) {
    const full = join(RAW_DIR, 'newsletters', String(nlId), 'messages-full.json')
    const capped = join(RAW_DIR, 'newsletters', String(nlId), 'messages.json')
    const path = existsSync(full) ? full : (existsSync(capped) ? capped : null)
    if (!path) continue
    if (path === full) withFull++
    try {
      const d = JSON.parse(readFileSync(path, 'utf8'))
      const msgs = Array.isArray(d) ? d : d.messages || []
      for (const m of msgs) {
        if (m.id) deliveryToNl.set(String(m.id), nlId)
      }
    } catch { /* ignore */ }
  }
  return { deliveryToNl, withFull }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[import] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} collection=${COLLECTION_SLUG}`)
  const weekly = loadWeeklyIndex()
  const { deliveryToNl, withFull } = buildDeliveryMap(weekly)
  console.log(`[import] weekly newsletters: ${weekly.size}, delivery_ids mapped: ${deliveryToNl.size} (full-message newsletters: ${withFull})`)

  // Resolve target collection + its editions (match by edition_date).
  const coll = await rest(`newsletters_template_collections?select=id,slug&slug=eq.${COLLECTION_SLUG}`)
  if (!coll.length) throw new Error(`Collection '${COLLECTION_SLUG}' not found`)
  const collectionId = coll[0].id
  const editions = await rest(`newsletters_editions?select=id,edition_date,title&collection_id=eq.${collectionId}`)
  const editionByDate = new Map(editions.map((e) => [String(e.edition_date), e]))
  console.log(`[import] target editions in collection: ${editions.length}`)

  // Which weekly newsletters map to an existing edition?
  let nlList = [...weekly.entries()]
    .map(([nlId, info]) => ({ nlId, ...info, edition: editionByDate.get(info.date) }))
    .filter((n) => n.edition)
  if (ONLY_NL) nlList = nlList.filter((n) => String(n.nlId) === String(ONLY_NL))
  if (LIMIT_NL) nlList = nlList.slice(0, Number(LIMIT_NL))
  const unmatched = weekly.size - [...weekly.values()].filter((i) => editionByDate.has(i.date)).length
  console.log(`[import] mapped newsletters→edition: ${nlList.length}; unmatched (no edition yet): ${unmatched}`)

  // Sweep dangling customer.io rows left behind by edition-id churn before we
  // re-link, so re-runs stay idempotent instead of accumulating dead rows.
  if (APPLY) await gcOrphans()

  // newsletterId → sendId (synthetic send per CIO newsletter, idempotent).
  const sendIdByNl = new Map()
  for (const n of nlList) {
    const marker = String(n.nlId)
    const existing = await rest(
      `newsletter_sends?select=id&edition_id=eq.${n.edition.id}&metadata->>cio_newsletter_id=eq.${marker}`,
    )
    const cioMetrics = loadCioMetrics(n.nlId)
    const meta = { cio_newsletter_id: marker, imported_from: 'customer.io', ...(cioMetrics ? { cio_metrics: cioMetrics } : {}) }
    // Summary counters shown on the send (Delivery Log stat cards).
    const counters = cioMetrics
      ? { total_recipients: cioMetrics.sent, sent_count: cioMetrics.delivered, failed_count: cioMetrics.bounced }
      : {}
    let sendId = existing[0]?.id
    if (!sendId && APPLY) {
      const created = await rest('newsletter_sends', {
        method: 'POST',
        prefer: 'return=representation',
        body: [{
          edition_id: n.edition.id,
          collection_id: collectionId,
          status: 'sent',
          subject: n.name || n.edition.title || 'Weekly Newsletter',
          from_address: 'imported@customer.io',
          adapter_id: 'html',
          schedule_type: 'scheduled',
          scheduled_at: isoFromUnix(n.sentAt),
          completed_at: isoFromUnix(n.sentAt),
          started_at: isoFromUnix(n.sentAt),
          metadata: meta,
          ...counters,
        }],
      })
      sendId = created[0].id
    }
    if (!sendId && !APPLY) sendId = `dryrun:${n.nlId}` // placeholder so dry-run measures routing
    if (sendId) {
      sendIdByNl.set(n.nlId, sendId)
      if (APPLY) {
        // Refresh CIO metrics + summary counters on the send (covers re-runs).
        await rest(`newsletter_sends?id=eq.${sendId}`, { method: 'PATCH', prefer: 'return=minimal', body: { metadata: meta, ...counters } })
        // Idempotency: clear prior imported rows for this send.
        await rest(`email_events?source=eq.customer.io&newsletter_send_id=eq.${sendId}`, { method: 'DELETE' })
        await rest(`email_send_log?provider=eq.customer.io&newsletter_send_id=eq.${sendId}`, { method: 'DELETE' })
      }
    }
  }

  // email_send_log comes from the COMPLETE per-recipient messages (every
  // delivery + its metrics), not the activities (which are an incomplete slice).
  // Activities are used only for raw email_events (UA/IP) + bot classification.
  let sendLogCount = 0
  for (const n of nlList) {
    const sendId = sendIdByNl.get(n.nlId)
    if (!sendId) continue
    const full = join(RAW_DIR, 'newsletters', String(n.nlId), 'messages-full.json')
    if (!existsSync(full)) continue
    let msgs
    try { msgs = JSON.parse(readFileSync(full, 'utf8')) } catch { continue }
    const rows = []
    for (const m of (Array.isArray(msgs) ? msgs : [])) {
      const email = m.recipient
      if (!email) continue
      const mx = m.metrics || {}
      rows.push({
        recipient_email: email,
        newsletter_send_id: sendId,
        provider: 'customer.io',
        recipient_customer_id: typeof m.customer_id === 'number' ? m.customer_id : null,
        status: mx.bounced || mx.dropped ? 'bounced' : (mx.delivered ? 'delivered' : 'sent'),
        delivered_at: isoFromUnix(mx.delivered),
        first_opened_at: isoFromUnix(mx.opened),
        first_clicked_at: isoFromUnix(mx.clicked),
        // List-churn signals (drives the SENT-drop breakdown): a genuine opt-out
        // (global or topic unsubscribe) vs system suppression (bounce/drop/spam).
        unsubscribed_at: isoFromUnix(mx.unsubscribed || mx.topic_unsubscribed),
        bounced_at: isoFromUnix(mx.bounced),
        dropped_at: isoFromUnix(mx.dropped),
        spam_reported_at: isoFromUnix(mx.spammed),
        subject: m.subject || null,
        queued_at: isoFromUnix(mx.sent || m.created),
        sent_at: isoFromUnix(mx.sent),
      })
    }
    sendLogCount += rows.length
    if (APPLY) {
      for (let i = 0; i < rows.length; i += 500) {
        await rest('email_send_log', { method: 'POST', prefer: 'return=minimal', body: rows.slice(i, i + 500) })
      }
    }
  }

  // Single streaming pass over all activity pages; route each event to its send.
  const activeNl = new Set(sendIdByNl.keys())
  let eventBuf = []
  const stats = { scanned: 0, routed: 0, unrouted: 0, byType: {}, inserted: 0, machine: 0 }

  const flush = async () => {
    if (!APPLY || eventBuf.length === 0) { eventBuf = []; return }
    const rows = eventBuf
    eventBuf = []
    const inserted = await rest('email_events', { method: 'POST', prefer: 'return=representation', body: rows.map((r) => r.event) })
    // Attach classifications by returned id (order preserved).
    const classRows = []
    inserted.forEach((ev, i) => {
      const c = rows[i].classification
      if (c) classRows.push({ event_id: ev.id, ...c })
    })
    if (classRows.length) {
      await rest('email_event_classifications', { method: 'POST', prefer: 'resolution=merge-duplicates', body: classRows })
    }
    stats.inserted += inserted.length
  }

  // Prefer the fuller fresh per-type pull (activities-full/{opened,clicked}_email);
  // fall back to the original mixed activities/ slice.
  const fullDirs = ['opened_email', 'clicked_email']
    .map((t) => join(RAW_DIR, 'activities-full', t))
    .filter((d) => existsSync(d))
  const actDirs = fullDirs.length ? fullDirs : [join(RAW_DIR, 'activities')]
  const pageRefs = actDirs.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f)))
  console.log(`[import] activity dirs: ${actDirs.map((d) => d.split('/').slice(-1)[0]).join(', ')} — ${pageRefs.length} pages`)

  for (const pagePath of pageRefs) {
    let parsed
    try { parsed = JSON.parse(readFileSync(pagePath, 'utf8')) } catch { continue }
    const acts = parsed.activities || (Array.isArray(parsed) ? parsed : [])
    for (const a of acts) {
      stats.scanned++
      const data = a.data || {}
      const deliveryId = a.delivery_id || data.delivery_id
      const nlId = deliveryId != null ? deliveryToNl.get(String(deliveryId)) : undefined
      if (nlId == null || !activeNl.has(nlId)) { stats.unrouted++; continue }
      const sendId = sendIdByNl.get(nlId)
      const eventType = TYPE_MAP[a.type]
      if (!eventType) { stats.unrouted++; continue }
      const email = a.customer_identifiers?.email || a.recipient || null
      if (!email) { stats.unrouted++; continue }
      const occurredAt = isoFromUnix(a.timestamp || data.opened || data.clicked || data.delivered)
      const machine = !!(data.prefetched || data.proxied)
      stats.routed++
      stats.byType[eventType] = (stats.byType[eventType] || 0) + 1
      if (machine) stats.machine++

      // Raw event with the ESP signals (UA/IP + prefetched/proxied/email_client).
      // Classification is NOT written here — the signals-v1 detector (which now
      // includes provider-flag MPP detection) scores these afterwards, so the
      // old crude 'mpp-flags-v0' baseline is no longer needed.
      eventBuf.push({
        event: {
          email,
          event_type: eventType,
          source: 'customer.io',
          newsletter_send_id: sendId,
          recipient: email,
          user_agent: data.user_agent || null,
          ip: parseIp(data.ip_address),
          link_url: data.href || data.link || null,
          event_timestamp: occurredAt,
          raw_payload: { cio_id: a.customer_identifiers?.cio_id, delivery_id: a.delivery_id, email_client: data.email_client, prefetched: !!data.prefetched, proxied: !!data.proxied, template_id: data.template_id },
        },
      })

      if (eventBuf.length >= 500) await flush()
    }
  }
  await flush()

  console.log('[import] ── report ──')
  console.log(JSON.stringify({
    mode: APPLY ? 'APPLY' : 'DRY-RUN',
    newslettersMappedToEdition: nlList.length,
    newslettersUnmatched: unmatched,
    emailSendLogRows: APPLY ? `${sendLogCount} (upserted)` : `${sendLogCount} (dry-run: would upsert)`,
    activityEventsScanned: stats.scanned,
    rawEventsRouted: stats.routed,
    rawEventsUnrouted: stats.unrouted,
    byType: stats.byType,
    machineClassified: stats.machine,
    emailEventsInserted: APPLY ? stats.inserted : `(dry-run: would insert ${stats.routed})`,
  }, null, 2))
}

function parseIp(raw) {
  if (!raw || typeof raw !== 'string') return null
  // CIO sometimes returns a comma list ("v6, v4"); take the first valid token.
  const first = raw.split(',')[0].trim()
  return first || null
}

main().catch((e) => { console.error('[import] FAILED:', e.message); process.exit(1) })
