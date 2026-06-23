// Backfill scoring for email_interactions rows that were inserted before the
// webhook's bot scoring path was fixed (AAIF prod 2026-06-23: 30,396
// unscored opens+clicks). Reads unscored rows in batches, builds the
// InteractionContext from email_send_log, runs the signals-v1 detector, and
// writes back human_confidence + bot_signals + scorer_id + scored_at.
//
// Compromise for batch backfill speed: the per-recipient cross-edition
// engagement history (humanOpenCount/humanClickCount) is set to 0 instead of
// queried per-row — the detector's negative signals (Apple MPP, known
// scanners, proxies, bot UA) still apply, but the "corroboration_repeat_
// opener" positive signal would underweight. Acceptable for a one-off
// catch-up; ongoing scoring via the webhook gets the full context.
//
// Run (Deno):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   deno run --allow-net --allow-env backfill-interaction-scores.ts \
//     [--batch 500] [--limit 100000] [--dry]

import detector from '../detector.ts';
import type { InteractionContext } from '../../bulk-emailing/types/bot-detector.ts';

const args = new Map<string, string>();
for (let i = 0; i < Deno.args.length; i++) {
  const a = Deno.args[i];
  if (a.startsWith('--')) {
    const key = a.replace(/^--/, '');
    const next = Deno.args[i + 1];
    if (!next || next.startsWith('--')) args.set(key, 'true');
    else { args.set(key, next); i++; }
  }
}
const BATCH = Number(args.get('batch') ?? '500');
const LIMIT = Number(args.get('limit') ?? '100000');
const DRY = args.get('dry') === 'true';
const BASE = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '');
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
if (!BASE || !KEY) {
  console.error('need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
  Deno.exit(1);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

interface SendLogEmbed {
  recipient_email: string;
  delivered_at: string | null;
}

interface InteractionRow {
  id: string;
  email_send_log_id: string;
  event_type: 'open' | 'click';
  event_timestamp: string;
  clicked_url: string | null;
  user_agent: string | null;
  ip_address: string | null;
  email_send_log: SendLogEmbed | null;
}

console.log(`[backfill] batch=${BATCH} limit=${LIMIT} dry=${DRY}`);

let processedTotal = 0;
let humanCount = 0;
let botCount = 0;

while (processedTotal < LIMIT) {
  const take = Math.min(BATCH, LIMIT - processedTotal);
  // PostgREST embedded select: pull email_send_log fields inline so we
  // don't need a second `?id=in.(...)` round-trip (which silently exceeded
  // the URL length limit at batch=1000 — http2 protocol error on AAIF).
  // scored_at=is.null is the unscored predicate.
  const rows = (await rest(
    `email_interactions?select=id,email_send_log_id,event_type,event_timestamp,clicked_url,user_agent,ip_address,email_send_log(recipient_email,delivered_at)&event_type=in.(open,click)&scored_at=is.null&order=event_timestamp.asc&limit=${take}`,
  )) as InteractionRow[];
  if (rows.length === 0) break;

  // Score each row.
  // is_bot is a GENERATED column on email_interactions (computed from
  // human_confidence) — including it in the upsert payload returns
  // PostgREST 428C9 "cannot insert a non-DEFAULT value into column". Score
  // it locally for the running tally only; PostgREST recomputes the column
  // on insert/update from human_confidence.
  const updates: Array<{ id: string; human_confidence: number; bot_signals: unknown; scorer_id: string; scored_at: string }> = [];
  const nowIso = new Date().toISOString();
  for (const r of rows) {
    const log = r.email_send_log;
    if (!log) continue;
    const ctx: InteractionContext = {
      eventType: r.event_type,
      eventTimestamp: new Date(r.event_timestamp),
      deliveredAt: log.delivered_at ? new Date(log.delivered_at) : null,
      userAgent: r.user_agent,
      ip: r.ip_address,
      clickedUrl: r.clicked_url,
      recipientEmail: log.recipient_email,
      // Backfill simplification: omit recent + history. See file header.
      recentInteractions: [],
      recipientHistory: { humanOpenCount: 0, humanClickCount: 0 },
    };
    const verdict = await detector.score(ctx);
    const isBot = verdict.humanConfidence < 0.5;
    updates.push({
      id: r.id,
      human_confidence: verdict.humanConfidence,
      bot_signals: verdict.signals,
      scorer_id: verdict.scorerId,
      scored_at: nowIso,
    });
    if (isBot) botCount++; else humanCount++;
  }

  if (DRY) {
    console.log(`[backfill] dry: would update ${updates.length} rows`);
  } else if (updates.length > 0) {
    // PostgREST upsert tries to INSERT when the payload lacks the table's
    // NOT NULL columns (here: email_send_log_id) — fails with 23502. PATCH
    // can only set ONE value per call. So we call a small SECURITY DEFINER
    // RPC that takes a jsonb array and does UPDATE FROM jsonb_to_recordset
    // — one round-trip per BATCH instead of per-row.
    const res = await fetch(`${BASE}/rest/v1/rpc/bulk_update_email_interaction_scores`, {
      method: 'POST',
      headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ p_updates: updates }),
    });
    if (!res.ok) {
      console.error(`[backfill] bulk update failed: ${res.status} ${(await res.text()).slice(0, 400)}`);
      Deno.exit(1);
    }
  }

  processedTotal += rows.length;
  console.log(`[backfill] processed ${processedTotal} total — human=${humanCount} bot=${botCount}`);
  if (rows.length < take) break;
}

console.log(`[backfill] DONE. processed=${processedTotal} human=${humanCount} bot=${botCount}`);
