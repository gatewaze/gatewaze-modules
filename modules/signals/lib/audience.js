/**
 * Audience resolution (spec-plays-audience-intelligence.md §4.7).
 *
 * resolveAudience(supabase, rule, context) → { personIds, count, ... }
 *
 * The audience_rule DSL:
 *   { base?, include?: Clause[], exclude?: Clause[], min_affinity?, source_allow? }
 * Clause:
 *   { type:'topic_affinity', topics: string[] | '{{context.topics}}', min_affinity?, source_allow? }
 *   { type:'region', region }
 *   { type:'geo_radius', center: '{{context.city}}' | {lat,lon}, radius_mi }
 *   { type:'registered_for_context' }
 *   { type:'segment', segment_id }   (deferred — treated as no-op)
 *
 * include[] clauses are AND-ed (intersection); exclude[] are subtracted. Context
 * templating ({{context.topics}}, {{context.city}}) is resolved from `context`
 * (supplied by the caller from the Play's context entity). Reads the governed,
 * source-weighted person_topic_interests via the people_by_topics RPC — so the
 * audience is source-agnostic and honours enabled sources + lawful basis.
 */

function haversineMi(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad((b.lat ?? b.latitude) - (a.lat ?? a.latitude));
  const dLon = toRad((b.lon ?? b.lng ?? b.longitude) - (a.lon ?? a.lng ?? a.longitude));
  const la1 = toRad(a.lat ?? a.latitude);
  const la2 = toRad(b.lat ?? b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function coordsOf(attributes) {
  const c = attributes && attributes.coordinates;
  if (!c) return null;
  const lat = c.lat ?? c.latitude;
  const lon = c.lon ?? c.lng ?? c.longitude;
  if (lat == null || lon == null) return null;
  return { lat: Number(lat), lon: Number(lon) };
}

export async function resolveAudience(supabase, rule, context) {
  rule = rule || {};
  const ctx = context || {};
  const minAff = Number(rule.min_affinity) || 0.5;
  const ctxTopics = Array.isArray(ctx.topics) ? ctx.topics : [];
  const resolveTopics = (t) => (t === '{{context.topics}}' ? ctxTopics : (Array.isArray(t) ? t : (t ? [t] : [])))
    .map(String).map((s) => s.trim()).filter(Boolean);

  const includeSets = [];
  const notes = { includes: [], excludes: [] };

  async function topicSet(clause) {
    const topics = resolveTopics(clause.topics);
    if (!topics.length) return new Set();
    const firstPartyOnly = Array.isArray(clause.source_allow)
      && clause.source_allow.length === 1 && clause.source_allow[0] === 'first_party_activity';
    const r = await supabase.rpc('people_by_topics', {
      p_topics: topics,
      p_min_affinity: Number(clause.min_affinity) || minAff,
      p_first_party_only: firstPartyOnly,
    });
    return new Set(((r && r.data) || []).map((x) => x.person_id));
  }

  async function registeredSet() {
    if (!ctx.context_id) return new Set();
    const r = await supabase.rpc('people_registered_for_event', { p_event_id: ctx.context_id });
    return new Set(((r && r.data) || []).map((x) => x.person_id));
  }

  async function regionSet(region) {
    const set = new Set();
    for (let from = 0; ; from += 1000) {
      const r = await supabase.from('people').select('id,attributes').eq('attributes->>region', region).range(from, from + 999);
      const data = (r && r.data) || [];
      for (const p of data) set.add(p.id);
      if (data.length < 1000) break;
    }
    return set;
  }

  async function geoSet(clause) {
    const center = clause.center === '{{context.city}}' ? ctx.coords : clause.center;
    const set = new Set();
    if (!center || center.lat == null) return set;
    const radius = Number(clause.radius_mi) || 100;
    for (let from = 0; ; from += 1000) {
      const r = await supabase.from('people').select('id,attributes').not('attributes->coordinates', 'is', null).range(from, from + 999);
      const data = (r && r.data) || [];
      for (const p of data) {
        const c = coordsOf(p.attributes);
        if (c && haversineMi(center, c) <= radius) set.add(p.id);
      }
      if (data.length < 1000) break;
    }
    return set;
  }

  async function clauseSet(clause) {
    switch (clause.type) {
      case 'topic_affinity': return topicSet(clause);
      case 'registered_for_context': return registeredSet();
      case 'region': return regionSet(clause.region);
      case 'geo_radius': return geoSet(clause);
      default: return null; // segment/other — deferred
    }
  }

  for (const clause of (rule.include || [])) {
    const s = await clauseSet(clause);
    if (s) { includeSets.push(s); notes.includes.push({ type: clause.type, count: s.size }); }
  }

  // base audience
  let audience;
  if (includeSets.length) {
    audience = includeSets.reduce((acc, s) => (acc === null ? new Set(s) : new Set([...acc].filter((x) => s.has(x)))), null) || new Set();
  } else if (rule.base === 'registered_for_context') {
    audience = await registeredSet();
  } else {
    audience = new Set(); // require an include or a base — never target everyone by accident
  }

  // exclusions
  const excludeSet = new Set();
  for (const clause of (rule.exclude || [])) {
    const s = await clauseSet(clause);
    if (s) { for (const x of s) excludeSet.add(x); notes.excludes.push({ type: clause.type, count: s.size }); }
  }

  const personIds = [...audience].filter((id) => !excludeSet.has(id));
  return { personIds, count: personIds.length, includedBeforeExclude: audience.size, excludedCount: audience.size - personIds.length, notes };
}
