// @ts-nocheck — depends on supabase-js; resolved at worker-host install time.

/**
 * signals:build-audience — a plays-aware forward worker (list_build).
 *
 * Resolves a Play's audience_rule into a concrete, snapshotted audience
 * (signals_audiences + signals_audience_members) and writes the audience id back
 * onto the Play's run_ref so the capability's locate() can track it. Never sends.
 *
 * Context templating ({{context.topics}}, {{context.city}}) is resolved here from
 * the Play's context entity (event.event_topics, member.metadata.topics, …) and
 * passed into resolveAudience.
 */

import { createClient } from '@supabase/supabase-js';
import { resolveAudience } from '../lib/audience.js';

if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = class { addEventListener() {} removeEventListener() {} close() {} send() {} };
}

async function resolveContext(supabase, contextType, contextId) {
  const out = { context_type: contextType, context_id: contextId, topics: [], coords: null, region: null };
  if (!contextType || !contextId) return out;
  try {
    if (contextType === 'event') {
      const r = await supabase.from('events').select('event_topics').eq('id', contextId).maybeSingle();
      out.topics = (r.data && r.data.event_topics) || [];
    } else if (contextType === 'member') {
      const r = await supabase.from('member_organizations').select('metadata').eq('id', contextId).maybeSingle();
      const md = (r.data && r.data.metadata) || {};
      out.topics = md.topics || md.solution_areas || md.areas || [];
    } else if (contextType === 'blog_post' || contextType === 'podcast') {
      // topics for blog/podcast come from content-keyword tagging; best-effort empty for now
      out.topics = [];
    }
  } catch { /* best-effort context resolution */ }
  return out;
}

export default async function handler(job, ctx) {
  const data = (job && job.data) || {};
  const playId = data.playId;
  const logger = (ctx && ctx.logger) || console;
  const log = (m, x) => (logger.info ? logger.info(`[signals:build-audience] ${m}`, x) : console.log(`[signals:build-audience] ${m}`, x || ''));
  const supabase = (ctx && ctx.supabase) || createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (!playId) { log('no playId — skipping'); return { skipped: true }; }
  const playRes = await supabase.from('plays').select('*').eq('id', playId).maybeSingle();
  const play = playRes.data;
  if (!play) { log('play not found', { playId }); return { skipped: true }; }
  if (play.run_ref && play.run_ref.id) { log('already has an audience — no-op', { playId }); return { audienceId: play.run_ref.id, idempotent: true }; }

  // resolve context
  let context = { context_type: null, context_id: null, topics: [] };
  if (play.playbook_id) {
    const pb = await supabase.from('playbooks').select('context_type,context_id').eq('id', play.playbook_id).maybeSingle();
    if (pb.data) context = await resolveContext(supabase, pb.data.context_type, pb.data.context_id);
  }

  // resolve the audience
  const rule = play.audience_rule || {};
  // apply config min_affinity as the rule default if not set on the rule
  if (play.config && play.config.min_affinity != null && rule.min_affinity == null) rule.min_affinity = Number(play.config.min_affinity);
  let res;
  try {
    res = await resolveAudience(supabase, rule, context);
  } catch (e) {
    await supabase.from('plays').update({ status: 'failed', error: `audience resolution failed: ${e.message}` }).eq('id', playId);
    log('resolve threw', { error: e.message });
    return { skipped: true };
  }

  // snapshot
  const ins = await supabase.from('signals_audiences').insert({
    site_id: play.site_id,
    name: play.title,
    context_type: context.context_type,
    context_id: context.context_id,
    rule,
    resolved_count: res.count,
  }).select('id').single();
  if (ins.error || !ins.data) {
    await supabase.from('plays').update({ status: 'failed', error: `audience insert failed: ${ins.error && ins.error.message}` }).eq('id', playId);
    return { skipped: true };
  }
  const audienceId = ins.data.id;

  // members (chunked)
  const members = res.personIds.map((pid) => ({ audience_id: audienceId, person_id: pid }));
  for (let i = 0; i < members.length; i += 1000) {
    const w = await supabase.from('signals_audience_members').insert(members.slice(i, i + 1000));
    if (w.error) log('member insert chunk failed', { error: w.error.message });
  }

  // run_ref back → the plays capability locate() tracks this audience
  await supabase.from('plays').update({ run_ref: { module: 'signals', table: 'signals_audiences', id: audienceId } }).eq('id', playId);

  log('resolved audience', { playId, audienceId, count: res.count, notes: res.notes });
  return { audienceId, count: res.count };
}
