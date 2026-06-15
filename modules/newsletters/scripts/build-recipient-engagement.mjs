#!/usr/bin/env node
// Build the cross-edition Customer.io recipient-engagement profile from ALL
// weekly newsletters' complete messages (cio-backup/newsletters/<id>/messages-full.json),
// independent of which editions are mapped into gatewaze. Powers click
// corroboration over the full history. Idempotent (upsert by recipient_email).
//
// SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node build-recipient-engagement.mjs [--raw-backup DIR]

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i !== -1 && args[i + 1] ? args[i + 1] : d }
const RAW_DIR = flag('raw-backup', '/Users/dan/Git/gatewaze/cio-backup')
const CONTENT_DIR = flag('content-backup', '/Users/dan/Git/gatewaze/cio-customerio-backup')
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '')
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!SUPABASE_URL || !KEY) { console.error('need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

const isoFromUnix = (s) => (typeof s === 'number' ? new Date(s * 1000).toISOString() : null)
const maxIso = (a, b) => (!a ? b : !b ? a : (a > b ? a : b))
const minIso = (a, b) => (!a ? b : !b ? a : (a < b ? a : b))

// All weekly newsletter ids.
const widx = JSON.parse(readFileSync(join(CONTENT_DIR, 'weekly-index.json'), 'utf8'))
const ids = [...new Set(Object.values(widx).map((e) => e.id))]

// email → aggregate
const prof = new Map()
let scanned = 0
for (const id of ids) {
  const p = join(RAW_DIR, 'newsletters', String(id), 'messages-full.json')
  if (!existsSync(p)) continue
  let msgs
  try { msgs = JSON.parse(readFileSync(p, 'utf8')) } catch { continue }
  for (const m of (Array.isArray(msgs) ? msgs : [])) {
    const email = m.recipient
    if (!email) continue
    scanned++
    const mx = m.metrics || {}
    let a = prof.get(email)
    if (!a) { a = { cio_id: null, del: 0, op: 0, cl: 0, first: null, lastOpen: null, lastClick: null }; prof.set(email, a) }
    if (typeof m.customer_id === 'number' && !a.cio_id) a.cio_id = String(m.customer_id)
    if (mx.delivered) a.del++
    if (mx.opened) { a.op++; a.lastOpen = maxIso(a.lastOpen, isoFromUnix(mx.opened)) }
    if (mx.clicked) { a.cl++; a.lastClick = maxIso(a.lastClick, isoFromUnix(mx.clicked)) }
    a.first = minIso(a.first, isoFromUnix(mx.sent || m.created))
  }
}
console.log(`[reng] scanned ${scanned} messages across ${ids.length} weeklies → ${prof.size} distinct recipients`)

const rows = [...prof.entries()].map(([email, a]) => ({
  recipient_email: email,
  cio_id: a.cio_id,
  editions_delivered: a.del,
  editions_opened: a.op,
  editions_clicked: a.cl,
  first_seen: a.first,
  last_open: a.lastOpen,
  last_click: a.lastClick,
  updated_at: new Date().toISOString(),
}))

let up = 0
for (let i = 0; i < rows.length; i += 500) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cio_recipient_engagement?on_conflict=recipient_email`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows.slice(i, i + 500)),
  })
  if (!res.ok) { console.error('upsert failed:', res.status, (await res.text()).slice(0, 200)); process.exit(1) }
  up += Math.min(500, rows.length - i)
}
const clickers = rows.filter((r) => r.editions_clicked > 0).length
console.log(JSON.stringify({ recipients: rows.length, upserted: up, distinct_clickers: clickers }, null, 2))
