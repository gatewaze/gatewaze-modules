/**
 * Play capabilities contributed by the resources module (spec §4.6).
 *
 * `resources:publish` is a content capability: produce/publish a Structured
 * Resource item. It IS reversible — a published item can be reverted to draft
 * (unpublish), so plays built on it can be rolled back from the Plays board.
 *
 * NOTE (integration seam): the resources module is API/MCP-driven (no worker
 * today), so the forward/reverse workers named here are the module's follow-on
 * adapters. locate() already derives status from the real sr_items row.
 */

export default {
  capabilities: [
    {
      key: 'resources:publish',
      kind: 'content',
      worker: 'resources:publish',
      reversible: true,
      reverseHandler: 'resources:unpublish',
      backend: 'api',
      async locate({ supabase, runRef }) {
        const id = runRef && runRef.id;
        if (!id) return { run_status: 'queued', artifact_ref: null };
        let row = null;
        try {
          const r = await supabase.from('sr_items').select('id,slug,status').eq('id', id).maybeSingle();
          row = r.data;
        } catch {
          return { run_status: 'running', artifact_ref: null };
        }
        if (!row) return { run_status: 'queued', artifact_ref: null };
        const published = String(row.status || '').toLowerCase() === 'published';
        return {
          run_status: published ? 'succeeded' : 'running',
          artifact_ref: published
            ? { module: 'resources', type: 'sr_item', id: row.id, relation: 'produces', url: row.slug ? `/resources/${row.slug}` : undefined }
            : null,
          detail: { current_step: row.status },
        };
      },
    },
  ],
};
