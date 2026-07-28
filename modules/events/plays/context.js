/**
 * Plays CONTEXT SOURCE for events (spec-plays-workflow-editor.md §4.4).
 *
 * Makes 'event' an operational context type: the plays sweep lists non-past
 * events lacking a live Playbook and clones matching templates onto them,
 * resolving each event's anchors (event_start/end/cfp_close) for event_relative
 * triggers and its attrs (tags/series/event_type) for applies_to filters.
 *
 * This wraps the logic that previously lived inline in plays/workers/sweep.ts, so
 * the sweep is now generic over context sources. Plain JS (loaded by the plays
 * orchestrator's context-source registry; must not import module TS).
 */

const DAY_MS = 86_400_000;

function coerce(e, defaultSiteId) {
  const attrs = e.attributes || {};
  const tags = Array.isArray(e.tags) ? e.tags : (Array.isArray(attrs.tags) ? attrs.tags : []);
  const series = Array.isArray(e.series) ? e.series : (e.series ? [e.series] : []);
  const event_type = e.event_type ?? e.type ?? undefined;
  return {
    id: e.id,
    // events is single-tenant on some brands (no site_id column) → default site
    site_id: e.site_id ?? defaultSiteId ?? null,
    anchors: {
      event_start: e.event_start ?? e.start_at ?? e.starts_at ?? e.start_date ?? null,
      event_end: e.event_end ?? e.end_at ?? e.ends_at ?? e.end_date ?? null,
      cfp_close: e.cfp_close ?? e.cfp_close_at ?? e.offer_close_date ?? attrs.cfp_close ?? null,
    },
    attrs: { tags, series, event_type },
  };
}

async function resolveDefaultSite(supabase) {
  try {
    const r = await supabase.from('sites').select('id').order('created_at', { ascending: true }).limit(1).maybeSingle();
    return r.data?.id ?? null;
  } catch {
    return null;
  }
}

export default {
  sources: [
    {
      type: 'event',
      label: 'Event',
      entityTable: 'events',
      anchors: ['event_start', 'event_end', 'cfp_close'],
      appliesToFields: ['tags', 'series', 'event_type'],

      async list({ supabase, defaultSiteId }) {
        const site = defaultSiteId ?? (await resolveDefaultSite(supabase));
        const r = await supabase.from('events').select('*').limit(200);
        if (r.error) return [];
        const nowMs = Date.now();
        const out = [];
        for (const raw of r.data ?? []) {
          const e = coerce(raw, site);
          if (!e.site_id) continue;
          // skip clearly-past events (ended > 1 day ago) — don't backfill stale playbooks
          const end = e.anchors.event_end;
          if (end && Date.parse(end) < nowMs - DAY_MS) continue;
          out.push(e);
        }
        return out;
      },

      async resolve({ supabase, id }) {
        const site = await resolveDefaultSite(supabase);
        const r = await supabase.from('events').select('*').eq('id', id).maybeSingle();
        if (r.error || !r.data) return null;
        const e = coerce(r.data, site);
        return { site_id: e.site_id, anchors: e.anchors, attrs: e.attrs };
      },
    },
  ],
};
