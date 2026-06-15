// Score an imported send's open/click events with the signals-v1 bot detector
// and store the verdicts as detection_source='bot-detector-signals', so they can
// be compared against Customer.io's authoritative human/machine split.
// Spec: spec-newsletter-personalised-delivery §6 (Part C, multi-source).
//
// Run (Deno):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   deno run -A score-edition.ts --send <sendId> [--threshold 0.5]

import detector from '../detector.ts'
import type { InteractionContext } from '../../bulk-emailing/types/bot-detector.ts'

const args = new Map<string, string>()
for (let i = 0; i < Deno.args.length; i += 2) args.set(Deno.args[i].replace(/^--/, ''), Deno.args[i + 1])
const SEND_ID = args.get('send')
const THRESHOLD = Number(args.get('threshold') ?? '0.5')
const BASE = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '')
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
if (!SEND_ID || !BASE || !KEY) { console.error('need --send + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY'); Deno.exit(1) }

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const t = await res.text()
  return t ? JSON.parse(t) : null
}

// Recipient → delivered_at (for timing signals).
const deliveredBy = new Map<string, Date>()
for (let from = 0; ; from += 1000) {
  const rows = await rest(`email_send_log?select=recipient_email,delivered_at&newsletter_send_id=eq.${SEND_ID}&order=recipient_email&limit=1000&offset=${from}`)
  for (const r of rows) if (r.delivered_at) deliveredBy.set(r.recipient_email, new Date(r.delivered_at))
  if (rows.length < 1000) break
}

// Cross-edition clicker profile (full CIO history): recipient → editions_clicked.
// A clicker anywhere is a confirmed human — fed as recipientHistory.humanClickCount.
const clicksBy = new Map<string, number>()
for (let from = 0; ; from += 1000) {
  const rows = await rest(`cio_recipient_engagement?select=recipient_email,editions_clicked&editions_clicked=gt.0&order=recipient_email&limit=1000&offset=${from}`)
  for (const r of rows) clicksBy.set(r.recipient_email, r.editions_clicked)
  if (rows.length < 1000) break
}
console.log(`[score] loaded ${clicksBy.size} cross-edition clickers`)

// All open/click events for this send, grouped per recipient for context.
type Ev = { id: string; email: string; type: string; ts: Date; ua: string | null; ip: string | null; url: string | null; raw: Record<string, unknown> | null }
const events: Ev[] = []
for (let from = 0; ; from += 1000) {
  const rows = await rest(`email_events?select=id,email,event_type,event_timestamp,user_agent,ip,link_url,raw_payload&newsletter_send_id=eq.${SEND_ID}&event_type=in.(opened,clicked)&order=event_timestamp&limit=1000&offset=${from}`)
  for (const r of rows) events.push({ id: r.id, email: r.email, type: r.event_type === 'opened' ? 'open' : 'click', ts: new Date(r.event_timestamp), ua: r.user_agent, ip: r.ip, url: r.link_url, raw: r.raw_payload ?? null })
  if (rows.length < 1000) break
}
console.log(`[score] loaded ${events.length} open/click events, ${deliveredBy.size} delivered timestamps`)

const byEmail = new Map<string, Ev[]>()
for (const e of events) { const a = byEmail.get(e.email) ?? []; a.push(e); byEmail.set(e.email, a) }

const classRows: Array<{ event_id: string; detection_source: string; is_human: boolean; confidence: number; reason: unknown }> = []
let human = 0, machine = 0, humanOpens = 0, machineOpens = 0
for (const e of events) {
  const peers = byEmail.get(e.email) ?? []
  const recent = peers.filter((p) => p !== e && Math.abs(p.ts.getTime() - e.ts.getTime()) < 60 * 60_000)
    .map((p) => ({ event_type: p.type, event_timestamp: p.ts, clicked_url: p.url, user_agent: p.ua, ip_address: p.ip }))
  const priorHumanOpens = peers.filter((p) => p.type === 'open' && p.ts < e.ts).length
  const ctx: InteractionContext = {
    eventType: e.type as 'open' | 'click',
    eventTimestamp: e.ts,
    deliveredAt: deliveredBy.get(e.email) ?? null,
    userAgent: e.ua,
    ip: e.ip,
    clickedUrl: e.url,
    recipientEmail: e.email,
    recentInteractions: recent,
    // humanOpenCount stays 0 — MPP opens aren't confirmable as human. The
    // defensible cross-edition signal is clicks (see clicksBy).
    recipientHistory: { humanOpenCount: priorHumanOpens, humanClickCount: clicksBy.get(e.email) ?? 0 },
    providerSignals: e.raw
      ? { prefetched: !!e.raw.prefetched, proxied: !!e.raw.proxied, emailClient: (e.raw.email_client as string) ?? null }
      : undefined,
  }
  const result = await detector.score(ctx)
  const isHuman = result.humanConfidence >= THRESHOLD
  classRows.push({ event_id: e.id, detection_source: 'bot-detector-signals', is_human: isHuman, confidence: result.humanConfidence, reason: { signals: result.signals } })
  if (isHuman) human++; else machine++
  if (e.type === 'open') { if (isHuman) humanOpens++; else machineOpens++ }
}

for (let i = 0; i < classRows.length; i += 500) {
  await rest('email_event_classifications?on_conflict=event_id,detection_source', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(classRows.slice(i, i + 500)) })
}

console.log(JSON.stringify({
  send_id: SEND_ID, scorer: detector.scorerId, threshold: THRESHOLD,
  total_events: events.length,
  open_events: humanOpens + machineOpens,
  human_opens: humanOpens, machine_opens: machineOpens,
  all_human: human, all_machine: machine,
}, null, 2))
