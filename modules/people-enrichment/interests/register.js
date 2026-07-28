/**
 * Interest-source connector for LinkedIn enrichment (spec-plays-audience-intelligence.md §4.2).
 *
 * The people-enrichment worker already FETCHES LinkedIn interests/activities/
 * articles from EnrichLayer and persists the raw payload in
 * `people_enrichments.enrichlayer_data` — it just discards `interests` before they
 * reach the person record (createMasterSummary). This connector routes that
 * already-persisted raw signal into the topic hub, so reuse needs NO change to the
 * enrichment worker and NO new external call.
 *
 * THIRD-PARTY + off by default + lawful-basis gated (signals_interest_sources).
 * Governance: these signals INFORM selection but their provenance is never shown
 * to a recipient (spec §7).
 */

export default {
  sources: [
    {
      key: 'enrichment',
      label: 'LinkedIn enrichment (EnrichLayer)',
      kind: 'third_party',
      default_enabled: false,
      requires_lawful_basis: true,
      async deriveBulk({ supabase }) {
        // people_enrichments may be absent on some brands — guard fully.
        let enr;
        try {
          enr = await supabase.from('people_enrichments').select('email,enrichlayer_data').limit(5000);
        } catch { return []; }
        if (!enr || enr.error || !enr.data || !enr.data.length) return [];
        // resolve email → person_id (people_enrichments is email-keyed)
        const byEmail = new Map();
        for (const r of enr.data) if (r.email) byEmail.set(String(r.email).toLowerCase(), r.enrichlayer_data || {});
        const emails = [...byEmail.keys()];
        const rows = [];
        // batch email → people.id
        const CHUNK = 500;
        for (let i = 0; i < emails.length; i += CHUNK) {
          const slice = emails.slice(i, i + CHUNK);
          const pr = await supabase.from('people').select('id,email').in('email', slice);
          for (const p of (pr.data || [])) {
            const raw = byEmail.get(String(p.email).toLowerCase());
            if (!raw) continue;
            const interests = Array.isArray(raw.interests) ? raw.interests : [];
            // activities/articles are weaker signals; take their titles as topics too, lightly
            const activityTitles = Array.isArray(raw.activities) ? raw.activities.map((a) => a && (a.title || a.name)).filter(Boolean) : [];
            for (const t of interests) rows.push({ person_id: p.id, topic: String(t), weight: 1.0, observed_at: null, evidence: { field: 'interests' } });
            for (const t of activityTitles.slice(0, 20)) rows.push({ person_id: p.id, topic: String(t), weight: 0.5, observed_at: null, evidence: { field: 'activities' } });
          }
        }
        return rows;
      },
    },
  ],
};
