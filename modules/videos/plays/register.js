/**
 * Play capabilities contributed by the videos module (spec §4.6).
 *
 * `videos:publish` is a content capability: surface/publish a canonical video
 * object (e.g. a session highlight). Reversible via unpublish. No dedicated
 * worker today (videos land via the video-scraper), so the forward/reverse
 * workers named here are the module's follow-on adapters; locate() derives
 * status from the real `videos` row.
 */

export default {
  capabilities: [
    {
      key: 'videos:publish',
      kind: 'content',
      worker: 'videos:publish',
      reversible: true,
      reverseHandler: 'videos:unpublish',
      backend: 'api',
      async locate({ supabase, runRef }) {
        const id = runRef && runRef.id;
        if (!id) return { run_status: 'queued', artifact_ref: null };
        let row = null;
        try {
          const r = await supabase.from('videos').select('id,slug,status,is_published').eq('id', id).maybeSingle();
          row = r.data;
        } catch {
          return { run_status: 'running', artifact_ref: null };
        }
        if (!row) return { run_status: 'queued', artifact_ref: null };
        const published = row.is_published === true || String(row.status || '').toLowerCase() === 'published';
        return {
          run_status: published ? 'succeeded' : 'running',
          artifact_ref: published ? { module: 'videos', type: 'video', id: row.id, relation: 'produces' } : null,
          detail: { current_step: row.status },
        };
      },
    },
  ],
};
