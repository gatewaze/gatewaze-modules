// Signals engine — evaluation + dispatch. Plain JS on purpose: imported by
// the manage API (Node/TS toolchain) AND required by the BullMQ worker
// handler, so one implementation serves both write paths.
//
// evaluateRule(supabase, rule, opts) walks the four moving parts:
//   1. content candidates — topic-matched resources/events (or explicit hrefs)
//   2. audience — person_topic_interests overlap (optionally segment-scoped),
//      or [null] for person-independent channels
//   3. scoring + dedupe + frequency caps -> signals_fires rows
//   4. dispatch — channel plugins: log | webhook | portal_pin | broadcast_draft
//
// The engine never owns send infrastructure: it decides, records, and hands
// off. Every fire is a row first, so a dispatch crash can't lose decisions.

const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

function def(rule) {
  const d = rule.definition || {};
  return {
    topics: (Array.isArray(d.topics) ? d.topics : []).filter((t) => typeof t === 'string' && TOPIC_RE.test(t)),
    minOverlap: Number.isInteger(d.min_overlap) ? d.min_overlap : 1,
    minWeight: typeof d.min_weight === 'number' ? d.min_weight : 1.0,
    content: {
      types: Array.isArray(d.content?.types) ? d.content.types : ['sr_item', 'event', 'video'],
      hrefs: Array.isArray(d.content?.hrefs) ? d.content.hrefs : [],
    },
    audience: {
      segmentId: d.audience?.segment_id || null,
      perPerson: d.audience?.per_person !== false,
      max: Number.isInteger(d.audience?.max) ? Math.min(d.audience.max, 2000) : 200,
    },
    channel: {
      type: d.channel?.type || 'log',
      config: d.channel?.config || {},
    },
    capDays: Number.isInteger(d.frequency_cap?.per_person_days) ? d.frequency_cap.per_person_days : 30,
    maxFiresPerRun: Number.isInteger(d.max_fires_per_run) ? Math.min(d.max_fires_per_run, 1000) : 200,
  };
}

/** Topic-matched content candidates: published resource items (via their
 *  blocks' manual + rule-derived topics) and upcoming listed events. */
async function contentCandidates(supabase, d) {
  const out = [];
  const seen = new Set();
  const push = (c) => { if (!seen.has(c.href)) { seen.add(c.href); out.push(c); } };

  for (const href of d.content.hrefs) {
    if (typeof href === 'string' && href.startsWith('/')) {
      push({ type: 'custom', href, title: href });
    }
  }
  if (d.topics.length === 0) return out;

  if (d.content.types.includes('sr_item')) {
    const orFilter = d.topics
      .flatMap((t) => [`data->topics.cs.${JSON.stringify([t])}`, `data->topics_auto.cs.${JSON.stringify([t])}`])
      .join(',');
    const { data: blocks } = await supabase
      .from('sr_blocks')
      .select('item_id, item:sr_items(title, slug, status, collection:sr_collections(slug, status))')
      .or(orFilter)
      .limit(80);
    const seenItems = new Set();
    for (const b of blocks || []) {
      if (seenItems.has(b.item_id)) continue;
      seenItems.add(b.item_id);
      const item = Array.isArray(b.item) ? b.item[0] : b.item;
      const collection = item && (Array.isArray(item.collection) ? item.collection[0] : item.collection);
      if (!item || !collection || item.status !== 'published' || collection.status !== 'published') continue;
      push({ type: 'sr_item', href: `/resources/${collection.slug}/${item.slug}`, title: item.title });
    }
  }

  if (d.content.types.includes('event')) {
    const { data: events } = await supabase
      .from('events')
      .select('event_id, event_slug, event_title, event_start, event_topics')
      .overlaps('event_topics', d.topics)
      .eq('is_listed', true)
      .gt('event_start', new Date().toISOString())
      .limit(20);
    for (const e of events || []) {
      const ref = e.event_slug || e.event_id;
      if (!ref || !e.event_title) continue;
      push({ type: 'event', href: `/events/${ref}`, title: e.event_title });
    }
  }

  // published videos whose canonical topics overlap the rule. Guarded — the
  // videos module may not be installed on every brand (missing table → skip).
  if (d.content.types.includes('video')) {
    const { data: videos, error: vErr } = await supabase
      .from('videos')
      .select('id, url, title, topics')
      .overlaps('topics', d.topics)
      .eq('status', 'published')
      .eq('visibility', 'public')
      .order('published_at', { ascending: false })
      .limit(20);
    if (!vErr) {
      for (const v of videos || []) {
        if (!v.url || !v.title) continue;
        push({ type: 'video', href: v.url, title: v.title });
      }
    }
  }

  return out;
}

/** People whose interest profile overlaps the rule topics strongly enough. */
async function audienceCandidates(supabase, d) {
  if (!d.audience.perPerson) return [{ personId: null, score: 1 }];
  if (d.topics.length === 0) return [];

  const { data: rows, error } = await supabase
    .from('person_topic_interests')
    .select('person_id, topic, weight')
    .in('topic', d.topics)
    .limit(20000);
  if (error) throw new Error(`interest query failed: ${error.message}`);

  const perPerson = new Map();
  for (const row of rows || []) {
    const cur = perPerson.get(row.person_id) || { topics: new Set(), weight: 0 };
    cur.topics.add(row.topic);
    cur.weight += row.weight;
    perPerson.set(row.person_id, cur);
  }

  let people = [...perPerson.entries()]
    .filter(([, v]) => v.topics.size >= d.minOverlap && v.weight >= d.minWeight)
    .map(([personId, v]) => ({ personId, score: v.weight }));

  if (d.audience.segmentId) {
    const { data: members } = await supabase
      .from('segments_memberships')
      .select('person_id')
      .eq('segment_id', d.audience.segmentId);
    const inSegment = new Set((members || []).map((m) => m.person_id));
    people = people.filter((p) => inSegment.has(p.personId));
  }

  people.sort((a, b) => b.score - a.score);
  return people.slice(0, d.audience.max);
}

// ── Channel plugins ──────────────────────────────────────────────────────────

function tagHref(href, fireId) {
  return `${href}${href.includes('?') ? '&' : '?'}gw_sig=${fireId}`;
}

const CHANNELS = {
  // record-only: the decision is the product (verification, dry-run-ish rules)
  async log() {
    return { ok: true };
  },

  // push the decision to any downstream system (CRM, ad audiences, Zapier…)
  async webhook(supabase, fire, config) {
    const url = typeof config.url === 'string' ? config.url : null;
    if (!url || !/^https?:\/\//.test(url)) return { ok: false, error: 'webhook channel requires config.url' };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.headers || {}) },
      body: JSON.stringify({
        fire_id: fire.id,
        rule_id: fire.rule_id,
        person_id: fire.person_id,
        content: { type: fire.content_type, href: fire.content_href, title: fire.content_title },
        score: fire.score,
        fired_at: fire.created_at,
      }),
    }).catch((err) => ({ ok: false, status: 0, statusText: String(err) }));
    return res.ok ? { ok: true } : { ok: false, error: `webhook ${res.status || ''} ${res.statusText || ''}`.trim() };
  },

  // route content onto the portal surface: a curated pin the related-content
  // resolver serves. Person-independent; the pinned href carries gw_sig so
  // clicks attribute back to this fire through the tracking relay.
  async portal_pin(supabase, fire, config, d) {
    const topic = typeof config.topic === 'string' && TOPIC_RE.test(config.topic) ? config.topic : d.topics[0];
    if (!topic) return { ok: false, error: 'portal_pin channel needs a topic (config.topic or rule topics)' };
    const href = config.attribute === false ? fire.content_href : tagHref(fire.content_href, fire.id);
    const { data: existing } = await supabase
      .from('related_pins')
      .select('id')
      .eq('topic', topic)
      .like('href', `${fire.content_href}%`)
      .limit(1);
    if (existing && existing.length > 0) return { ok: true, note: 'pin already present' };
    const { error } = await supabase.from('related_pins').insert({
      topic,
      title: fire.content_title,
      href,
      description: typeof config.description === 'string' ? config.description : null,
      card_type: fire.content_type === 'event' ? 'event'
        : fire.content_type === 'video' ? 'video'
        : 'resource',
      sort_order: Number.isInteger(config.sort_order) ? config.sort_order : 50,
      active: true,
    });
    return error ? { ok: false, error: error.message } : { ok: true };
  },

  // draft a broadcast for a human to review/send — Signals never sends email
  // itself. A broadcasts row with no send attached IS a draft in that module.
  async broadcast_draft(supabase, fire, config) {
    const { error } = await supabase.from('broadcasts').insert({
      name: `[signals] ${fire.content_title}`.slice(0, 120),
      brand: config.brand || 'default',
      channel: 'email',
      audience_type: config.audience_type || 'list',
      list_ids: Array.isArray(config.list_ids) ? config.list_ids : [],
      subject: (config.subject || `Recommended: ${fire.content_title}`).slice(0, 200),
      content_json: {
        source: 'signals',
        fire_id: fire.id,
        body_intro: config.body_intro || null,
        content: { href: tagHref(fire.content_href, fire.id), title: fire.content_title, type: fire.content_type },
      },
    });
    return error ? { ok: false, error: error.message } : { ok: true };
  },
};

async function dispatchFire(supabase, fire, d) {
  const plugin = CHANNELS[d.channel.type];
  if (!plugin) {
    return supabase.from('signals_fires')
      .update({ status: 'failed', error: `unknown channel '${d.channel.type}'` })
      .eq('id', fire.id);
  }
  let result;
  try {
    result = await plugin(supabase, fire, d.channel.config, d);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  await supabase.from('signals_fires')
    .update(result.ok
      ? { status: 'dispatched', dispatched_at: new Date().toISOString(), error: null }
      : { status: 'failed', error: result.error || 'dispatch failed' })
    .eq('id', fire.id);
  return result;
}

/**
 * Evaluate one rule end to end. Returns a summary the caller can log or
 * return to an API client. opts.dryRun skips fire creation and dispatch.
 */
async function evaluateRule(supabase, rule, opts = {}) {
  const d = def(rule);
  const summary = {
    rule_id: rule.id, rule: rule.name, channel: d.channel.type,
    candidates: 0, audience: 0, pairs: 0,
    fired: 0, dispatched: 0, failed: 0, deduped: 0, capped: 0,
    dry_run: !!opts.dryRun,
  };

  const content = await contentCandidates(supabase, d);
  const audience = await audienceCandidates(supabase, d);
  summary.candidates = content.length;
  summary.audience = audience.length;
  if (content.length === 0 || audience.length === 0) {
    if (!opts.dryRun) {
      await supabase.from('signals_rules').update({ last_evaluated_at: new Date().toISOString() }).eq('id', rule.id);
    }
    return summary;
  }

  // existing fires for dedupe (rule-scoped)
  const { data: existing } = await supabase
    .from('signals_fires')
    .select('person_id, content_href')
    .eq('rule_id', rule.id);
  const already = new Set((existing || []).map((f) => `${f.person_id || 'null'}|${f.content_href}`));

  // frequency-cap state: recent fires per person on this channel (any rule)
  const capSince = new Date(Date.now() - d.capDays * 86400_000).toISOString();
  const personIds = audience.map((a) => a.personId).filter(Boolean);
  const capped = new Set();
  if (personIds.length > 0) {
    const { data: recent } = await supabase
      .from('signals_fires')
      .select('person_id')
      .in('person_id', personIds)
      .eq('channel', d.channel.type)
      .gte('created_at', capSince)
      .neq('status', 'suppressed');
    for (const r of recent || []) capped.add(r.person_id);
  }

  for (const person of audience) {
    if (summary.fired >= d.maxFiresPerRun) break;
    if (person.personId && capped.has(person.personId)) { summary.capped++; continue; }
    for (const c of content) {
      if (summary.fired >= d.maxFiresPerRun) break;
      summary.pairs++;
      if (already.has(`${person.personId || 'null'}|${c.href}`)) { summary.deduped++; continue; }
      if (opts.dryRun) { summary.fired++; continue; }

      const { data: fire, error } = await supabase
        .from('signals_fires')
        .insert({
          rule_id: rule.id,
          person_id: person.personId,
          content_type: c.type,
          content_href: c.href,
          content_title: c.title,
          channel: d.channel.type,
          score: person.score,
          payload: { topics: d.topics },
        })
        .select()
        .single();
      if (error) {
        if (/duplicate key/.test(error.message)) { summary.deduped++; continue; }
        throw new Error(`fire insert failed: ${error.message}`);
      }
      summary.fired++;
      const result = await dispatchFire(supabase, fire, d);
      if (result && result.ok) summary.dispatched++; else summary.failed++;
      // person-level cap applies within the run too
      if (person.personId) capped.add(person.personId);
    }
  }

  if (!opts.dryRun) {
    await supabase.from('signals_rules').update({ last_evaluated_at: new Date().toISOString() }).eq('id', rule.id);
  }
  return summary;
}

/** Evaluate every active rule whose interval has elapsed. */
async function evaluateDueRules(supabase, opts = {}) {
  const { data: rules, error } = await supabase
    .from('signals_rules')
    .select('*')
    .eq('status', 'active');
  if (error) throw new Error(`rules query failed: ${error.message}`);
  const results = [];
  for (const rule of rules || []) {
    const interval = Number.isInteger(rule.definition?.interval_minutes) ? rule.definition.interval_minutes : 1440;
    const due = !rule.last_evaluated_at ||
      Date.now() - Date.parse(rule.last_evaluated_at) >= interval * 60_000;
    if (!due && !opts.force) continue;
    try {
      results.push(await evaluateRule(supabase, rule, opts));
    } catch (err) {
      results.push({ rule_id: rule.id, rule: rule.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

module.exports = { evaluateRule, evaluateDueRules, CHANNELS };
