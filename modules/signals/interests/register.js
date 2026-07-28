/**
 * Interest-source connectors contributed by the signals module
 * (spec-plays-audience-intelligence.md §4.2). Each source maps its raw data to
 * topic signals; the `interests:sync` worker normalises the topics (topic_vocabulary)
 * and upserts weighted, source-tagged rows into signals_interests. Sources are
 * toggled + weighted via the signals_interest_sources config table.
 *
 * deriveBulk({ supabase, sinceIso }) → [{ person_id, topic (raw), weight, observed_at?, evidence? }]
 *
 * Note: event-registration topics are already unioned into person_topic_interests
 * by the view (source='event_registration'), so first_party_activity here covers
 * the OTHER first-party signals (video/guide consumption) to avoid double-counting.
 */

function normPath(url) {
  try { return new URL(url, 'http://x').pathname.replace(/\/+$/, '') || '/'; }
  catch { return String(url || '').split('?')[0].replace(/\/+$/, '') || '/'; }
}

export default {
  sources: [
    {
      key: 'first_party_activity',
      label: 'First-party activity',
      kind: 'first_party',
      default_enabled: true,
      async deriveBulk({ supabase, sinceIso }) {
        const rows = [];
        const ev = await supabase
          .from('people_events')
          .select('person_id,event_name,event_data,occurred_at')
          .in('event_name', ['video_play', 'page_view'])
          .gte('occurred_at', sinceIso)
          .limit(5000);
        const events = (ev && ev.data) || [];
        // resolve video ids → videos.topics
        const videoIds = new Set();
        const paths = new Set();
        for (const e of events) {
          if (!e.person_id) continue;
          const d = e.event_data || {};
          if (String(e.event_name).includes('video') && d.video_id) videoIds.add(String(d.video_id));
          else if (d.url) paths.add(normPath(d.url));
        }
        const vmap = {};
        if (videoIds.size) {
          const vr = await supabase.from('videos').select('provider_video_id,topics').in('provider_video_id', [...videoIds]);
          for (const v of (vr.data || [])) vmap[v.provider_video_id] = v.topics || [];
        }
        // resolve page paths → content → topics (via url_content_map)
        const pmap = {};
        if (paths.size) {
          const ur = await supabase.from('url_content_map').select('path,content_type,content_id').in('path', [...paths]);
          const byType = { sr_item: [], video: [], event: [] };
          const pathOf = {};
          for (const u of (ur.data || [])) { if (byType[u.content_type]) { byType[u.content_type].push(u.content_id); pathOf[`${u.content_type}:${u.content_id}`] = u.path; } }
          const topicsFor = async (table, ids, col) => {
            if (!ids.length) return;
            const r = await supabase.from(table).select(`id,${col}`).in('id', ids);
            for (const row of (r.data || [])) { const p = pathOf[`${table === 'sr_items' ? 'sr_item' : table === 'videos' ? 'video' : 'event'}:${row.id}`]; if (p) pmap[p] = row[col] || []; }
          };
          // sr_items topics come from the item's own topics col (added by audience-intel resources migration) — fall back to empty
          await topicsFor('videos', byType.video, 'topics');
          await topicsFor('events', byType.event, 'event_topics');
          await topicsFor('sr_items', byType.sr_item, 'topics');
        }
        for (const e of events) {
          if (!e.person_id) continue;
          const d = e.event_data || {};
          const obs = e.occurred_at || sinceIso;
          if (String(e.event_name).includes('video') && d.video_id) {
            for (const t of (vmap[String(d.video_id)] || [])) rows.push({ person_id: e.person_id, topic: t, weight: 1.0, observed_at: obs, evidence: { video_id: d.video_id } });
          } else if (d.url) {
            const p = normPath(d.url);
            for (const t of (pmap[p] || [])) rows.push({ person_id: e.person_id, topic: t, weight: 0.8, observed_at: obs, evidence: { path: p } });
          }
        }
        return rows;
      },
    },
    {
      key: 'self_declared',
      label: 'Self-declared (onboarding topics)',
      kind: 'self_declared',
      default_enabled: true,
      async deriveBulk({ supabase }) {
        const rows = [];
        const PAGE = 1000;
        // Only people whose topics is present and not the empty array — the
        // populated cohort is sparse in a large people table, so filter first,
        // then paginate through it (never a flat limit that misses people).
        for (let from = 0; ; from += PAGE) {
          const pr = await supabase
            .from('people')
            .select('id,attributes')
            .not('attributes->>topics', 'is', null)
            .neq('attributes->>topics', '[]')
            .range(from, from + PAGE - 1);
          const data = (pr && pr.data) || [];
          if (!data.length) break;
          for (const p of data) {
            let t = p.attributes && p.attributes.topics;
            // topics is sometimes stored double-encoded as a JSON string
            if (typeof t === 'string') { try { t = JSON.parse(t); } catch { t = t.trim() ? [t] : []; } }
            const arr = Array.isArray(t) ? t : (t ? [t] : []);
            for (const raw of arr) {
              const s = String(raw).trim();
              if (s) rows.push({ person_id: p.id, topic: s, weight: 1.0, observed_at: null });
            }
          }
          if (data.length < PAGE) break;
        }
        return rows;
      },
    },
  ],
};
