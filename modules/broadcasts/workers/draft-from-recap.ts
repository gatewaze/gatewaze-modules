// @ts-nocheck — depends on supabase-js; resolved at worker-host install time.

/**
 * broadcasts:draft-from-recap — a plays-aware forward worker.
 *
 * Turns a conference recap into a DRAFT broadcast (never sends). Dispatched by
 * the plays engine when a recap-follow-up communication Play runs. It:
 *   1. loads the Play, finds the sibling `post_recap` play in the same Playbook,
 *      and reads the conference_recap it attached to (→ its published sr_item);
 *   2. pulls a few talk highlights (sr_blocks kind='talk') from that recap;
 *   3. inserts a draft `broadcasts` row (type='event_recap') + a single `text`
 *      block carrying the highlight HTML;
 *   4. writes the new broadcast id back onto the Play's run_ref so the plays
 *      capability's locate() can track it.
 * Idempotent: a Play that already has a run_ref is a no-op (returns the existing
 * broadcast), and a broadcast is drafted, never sent — the send stays a separate,
 * human step in the broadcasts editor.
 */

import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'node:module';
import {
  RECAP_TOKEN, recapMarker, scoreTalk, buildHighlightsHtml,
} from '../lib/recap-highlights.js';

if (typeof (globalThis as Record<string, unknown>).WebSocket === 'undefined') {
  (globalThis as Record<string, unknown>).WebSocket = class {
    addEventListener() {} removeEventListener() {} close() {} send() {}
  };
}

const DEFAULT_HIGHLIGHT_COUNT = 4;

// Read a capability configSchema knob off the play, falling back to the default.
function cfgInt(play, key, def, min, max) {
  const v = play && play.config && play.config[key];
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Nudge the plays engine to advance one play now (so it locates the fresh draft
 * and settles to in_review promptly, instead of waiting for the ~10-min sweep).
 * Resolves bullmq through the API package's graph — a bare import fails from a
 * module's on-disk location. Fully guarded: on any failure the sweep still
 * catches the play later.
 */
async function pokePlaysAdvance(playId, log) {
  if (!process.env.REDIS_URL) return;
  let Queue = null;
  for (const anchor of [`${process.cwd()}/packages/api/package.json`, '/app/packages/api/package.json']) {
    try { Queue = createRequire(anchor)('bullmq').Queue; if (Queue) break; } catch { /* next anchor */ }
  }
  if (!Queue) { try { Queue = (await import('bullmq')).Queue; } catch { /* unresolved */ } }
  if (!Queue) return;
  const url = new URL(process.env.REDIS_URL);
  const q = new Queue('jobs', {
    connection: { host: url.hostname, port: Number(url.port || 6379), password: url.password || undefined, username: url.username || undefined },
    prefix: `bull:${process.env.BRAND || 'default'}`,
  });
  try {
    await q.add('plays:advance', { kind: 'plays:advance', playId }, { removeOnComplete: true, removeOnFail: 500 });
  } finally {
    try { await q.close(); } catch { /* ignore */ }
  }
}

// ── Audience-aware talk ranking (spec-plays-audience-intelligence §4.8) ──────
// Pick the highlights the target audience cares about most, rather than raw
// curated order. Kept inline (no cross-module import): the affinity aggregation
// lives in the signals-owned RPC `topic_affinity_for_people`, callable by any
// module's supabase client.

// Resolve the person set to personalise against: a sibling signals:build-audience
// play's snapshotted audience if present, else the event's registered attendees.
async function resolveAudiencePersonIds(supabase, play, eventId) {
  if (play.playbook_id) {
    const sib = await supabase
      .from('plays')
      .select('run_ref,capability_key')
      .eq('playbook_id', play.playbook_id)
      .eq('capability_key', 'signals:build-audience')
      .eq('is_template', false)
      .maybeSingle();
    const audienceId = sib.data && sib.data.run_ref && sib.data.run_ref.id;
    if (audienceId) {
      const ids = [];
      for (let from = 0; ; from += 1000) {
        const r = await supabase.from('signals_audience_members').select('person_id').eq('audience_id', audienceId).range(from, from + 999);
        const rows = (r && r.data) || [];
        for (const x of rows) ids.push(x.person_id);
        if (rows.length < 1000) break;
      }
      if (ids.length) return ids;
    }
  }
  if (eventId) {
    const r = await supabase.rpc('people_registered_for_event', { p_event_id: eventId });
    return ((r && r.data) || []).map((x) => x.person_id).filter(Boolean);
  }
  return [];
}

// Order candidate talk blocks by audience affinity (stable; original order on
// ties or when there is no affinity data), then return the top `count`.
async function selectTalks(supabase, blocks, count, personalize, play, eventId, log) {
  const all = blocks || [];
  if (!personalize || all.length <= count) return all.slice(0, count);
  const personIds = await resolveAudiencePersonIds(supabase, play, eventId);
  if (!personIds.length) { log('personalise: no audience/registrations — using curated order'); return all.slice(0, count); }
  const aff = await supabase.rpc('topic_affinity_for_people', { p_person_ids: personIds });
  const affinity = new Map();
  for (const row of ((aff && aff.data) || [])) if (row && row.topic) affinity.set(String(row.topic), Number(row.weight) || 0);
  const scored = all.map((item, index) => ({ item, index, score: scoreTalk(item, affinity) }));
  if (!scored.some((s) => s.score > 0)) { log('personalise: audience has no matching topics — using curated order'); return all.slice(0, count); }
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  log('personalise: ranked talks by audience affinity', { audience: personIds.length, topics: affinity.size, top: scored.slice(0, count).map((s) => (s.item.data && s.item.data.title) || '').filter(Boolean) });
  return scored.slice(0, count).map((s) => s.item);
}


export default async function handler(job, ctx) {
  const data = (job && job.data) || {};
  const playId = data.playId;
  const logger = (ctx && ctx.logger) || console;
  const log = (m, x) => (logger.info ? logger.info(`[broadcasts:draft-from-recap] ${m}`, x) : console.log(`[broadcasts:draft-from-recap] ${m}`, x || ''));
  const supabase =
    (ctx && ctx.supabase) ||
    createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  const brand = process.env.BRAND || 'default';

  if (!playId) { log('no playId in job data — skipping'); return { skipped: true }; }

  // 1. load the play
  const playRes = await supabase.from('plays').select('*').eq('id', playId).maybeSingle();
  const play = playRes.data;
  if (!play) { log('play not found', { playId }); return { skipped: true }; }
  // idempotency: already produced a broadcast
  if (play.run_ref && play.run_ref.id) {
    log('play already has a broadcast — no-op', { playId, broadcast: play.run_ref.id });
    return { broadcastId: play.run_ref.id, idempotent: true };
  }

  // 2. resolve the recap via the sibling post_recap play in the same playbook
  let recap = null;
  let eventId = null;
  if (play.playbook_id) {
    const pb = await supabase.from('playbooks').select('context_type,context_id').eq('id', play.playbook_id).maybeSingle();
    if (pb.data && pb.data.context_type === 'event') eventId = pb.data.context_id;
    const sib = await supabase
      .from('plays')
      .select('run_ref,artifact_ref')
      .eq('playbook_id', play.playbook_id)
      .eq('play_key', 'post_recap')
      .eq('is_template', false)
      .maybeSingle();
    const recapRunId = sib.data && sib.data.run_ref && sib.data.run_ref.id;
    if (recapRunId) {
      const cr = await supabase
        .from('conference_recaps')
        .select('id,event_name,title,sr_item_id,item_slug,playlist_id')
        .eq('id', recapRunId)
        .maybeSingle();
      recap = cr.data;
    }
  }
  if (!recap) {
    // No attached recap — mark the play failed with a clear reason (the engine
    // maps failed status; do not fabricate an empty broadcast).
    await supabase.from('plays').update({ status: 'failed', error: 'no attached conference recap found for this playbook (run the recap play first)' }).eq('id', playId);
    log('no attached recap — failing play', { playId });
    return { skipped: true, reason: 'no_recap' };
  }
  const eventName = recap.event_name || recap.title || 'the event';

  // 3. pull talk highlights from the recap's published resource item.
  //    Two personalization modes (config, spec-plays-audience-intelligence §4.8):
  //    - ordering:'affinity' → rank once by the AGGREGATE audience affinity now.
  //    - personalize:true    → defer to SEND time: emit a {{recap_highlights_block}}
  //      token + a marker, and the send-engine binding ranks talks by EACH
  //      recipient's own affinity (raw SendGrid substitution). One draft, per-
  //      recipient bodies. Falls back to aggregate/curated if the recap has no
  //      published item to source talks from.
  const highlightCount = cfgInt(play, 'highlight_count', DEFAULT_HIGHLIGHT_COUNT, 1, 12);
  const cfg = (play && play.config) || {};
  const perRecipient = cfg.personalize === true;
  const aggregateAffinity = cfg.ordering === 'affinity';
  let talks = [];
  if (recap.sr_item_id) {
    const blocks = await supabase
      .from('sr_blocks')
      .select('kind,data,sort_order')
      .eq('item_id', recap.sr_item_id)
      .in('kind', ['talk', 'video'])
      .order('sort_order', { ascending: true });
    talks = await selectTalks(supabase, blocks.data || [], highlightCount, aggregateAffinity, play, eventId, log);
  }

  // 4. build the draft body — token+marker when personalising per recipient.
  const sendTimePersonalized = perRecipient && !!recap.sr_item_id;
  const html = sendTimePersonalized
    ? `${recapMarker({ item_id: recap.sr_item_id, count: highlightCount, event_name: eventName })}\n${RECAP_TOKEN}`
    : buildHighlightsHtml(eventName, talks);
  const subject = `Recap: ${eventName}`;
  if (sendTimePersonalized) log('per-recipient personalization: emitting recap token', { item_id: recap.sr_item_id, count: highlightCount });

  // 5. insert the DRAFT broadcast (parent row; no send)
  const ins = await supabase
    .from('broadcasts')
    .insert({
      name: `${eventName} — recap follow-up`,
      brand,
      channel: 'email',
      type: 'event_recap',
      subject,
      preheader: `A few highlights from ${eventName}`,
      body_text: `Highlights from ${eventName}.`,
      rendered_html: html,
      content_json: { html },
      ...(eventId ? { event_id: eventId } : {}),
    })
    .select('id')
    .single();
  if (ins.error || !ins.data) {
    await supabase.from('plays').update({ status: 'failed', error: `failed to create broadcast: ${ins.error && ins.error.message}` }).eq('id', playId);
    log('broadcast insert failed', { error: ins.error && ins.error.message });
    return { skipped: true, reason: 'insert_failed' };
  }
  const broadcastId = ins.data.id;

  // 6. add a single rich-text block carrying the highlight HTML (round-trips in the editor)
  await supabase.from('broadcast_blocks').insert({
    broadcast_id: broadcastId,
    block_type: 'text',
    templates_block_def_id: null,
    content: { body: html },
    sort_order: 0,
  });

  // 7. write run_ref back so the plays capability's locate() tracks this draft
  await supabase.from('plays').update({ run_ref: { module: 'broadcasts', table: 'broadcasts', id: broadcastId } }).eq('id', playId);

  // 8. nudge the play to locate the fresh draft now (settles to in_review promptly)
  try { await pokePlaysAdvance(playId, log); } catch (e) { log('post-draft advance poke failed', { error: e && e.message }); }

  log('drafted broadcast from recap', { playId, broadcastId, talks: talks.length, event: eventName });
  return { broadcastId, talks: talks.length };
}
