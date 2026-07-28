/**
 * Content ranking (spec-plays-audience-intelligence.md §4.8).
 *
 * Given an affinity map { topic -> weight } (from topic_affinity_for_people over
 * an audience, or over one person for send-time personalization) and a list of
 * candidate content items each carrying `topics` (+ optional `topics_auto`),
 * score each item by how much the audience cares about its topics and return the
 * items ordered most-relevant first. `topics_auto` (keyword-derived) counts at a
 * discount vs curated `topics`.
 *
 * Ranking is STABLE: ties keep the caller's original order (e.g. the recap's
 * curated sort_order), so with no affinity data the output equals the input.
 */

const AUTO_TOPIC_WEIGHT = 0.5;

function itemTopics(item) {
  const d = (item && item.data) || item || {};
  const curated = Array.isArray(d.topics) ? d.topics : [];
  const auto = Array.isArray(d.topics_auto) ? d.topics_auto : [];
  return { curated: curated.map(String), auto: auto.map(String) };
}

/** Score one item against an affinity map. */
export function scoreItem(item, affinity) {
  if (!affinity || typeof affinity.get !== 'function') return 0;
  const { curated, auto } = itemTopics(item);
  let score = 0;
  const counted = new Set();
  for (const t of curated) { const w = affinity.get(t); if (w) { score += w; counted.add(t); } }
  for (const t of auto) { if (counted.has(t)) continue; const w = affinity.get(t); if (w) score += w * AUTO_TOPIC_WEIGHT; }
  return score;
}

/**
 * Rank items by affinity (stable, descending). Returns a new array of
 * { item, score, index } — callers map back to their items. When no item scores
 * (empty/blank affinity), the original order is preserved verbatim.
 */
export function rankByAffinity(items, affinity) {
  const scored = (items || []).map((item, index) => ({ item, index, score: scoreItem(item, affinity) }));
  const anyScore = scored.some((s) => s.score > 0);
  if (!anyScore) return scored; // preserve original order
  return scored.slice().sort((a, b) => (b.score - a.score) || (a.index - b.index));
}

/** Build a Map from a topic_affinity_for_people RPC result ([{topic,weight}]). */
export function affinityMap(rows) {
  const m = new Map();
  for (const r of (rows || [])) if (r && r.topic) m.set(String(r.topic), Number(r.weight) || 0);
  return m;
}
