/**
 * Plays CONTEXT SOURCE for blog posts (spec-plays-workflow-editor.md §4.4).
 *
 * Makes 'blog_post' an operational context type: a published post can auto-clone
 * a template (e.g. "notify people interested in this topic"). Anchor `published_at`
 * drives event_relative timing; attr `content_category` drives applies_to filters.
 * Plain JS; must not import module TS.
 */

async function defaultSite(supabase, given) {
  if (given) return given;
  try {
    const r = await supabase.from('sites').select('id').order('created_at', { ascending: true }).limit(1).maybeSingle();
    return r.data?.id ?? null;
  } catch { return null; }
}

const DAY_MS = 86_400_000;

export default {
  sources: [
    {
      type: 'blog_post',
      label: 'Blog post',
      entityTable: 'blog_posts',
      anchors: ['published_at'],
      appliesToFields: ['content_category'],

      async list({ supabase, defaultSiteId }) {
        const site = await defaultSite(supabase, defaultSiteId);
        // published posts from the last 60 days — the window a post playbook still acts on
        const sinceIso = new Date(Date.now() - 60 * DAY_MS).toISOString();
        const r = await supabase
          .from('blog_posts')
          .select('id,published_at,content_category,status,publish_state')
          .eq('status', 'published')
          .gte('published_at', sinceIso)
          .limit(300);
        if (r.error) return [];
        return (r.data ?? [])
          .filter((p) => p.published_at)
          .map((p) => ({ id: p.id, site_id: site, anchors: { published_at: p.published_at }, attrs: { content_category: p.content_category ?? null } }));
      },

      async resolve({ supabase, id }) {
        const site = await defaultSite(supabase, null);
        const r = await supabase.from('blog_posts').select('id,published_at,content_category').eq('id', id).maybeSingle();
        if (r.error || !r.data) return null;
        return { site_id: site, anchors: { published_at: r.data.published_at ?? null }, attrs: { content_category: r.data.content_category ?? null } };
      },
    },
  ],
};
