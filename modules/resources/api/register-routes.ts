// @ts-nocheck — depends on express + supabase-js; resolved at module-host install time.
//
// Server routes for the resources module. Mounted under
// /api/modules/resources/* — the platform labels /api/modules/<id> as 'jwt',
// so a valid session is required; we additionally verify the caller is an
// admin (is_admin RPC) before running the paid cover-image generation.
//
// POST /api/modules/resources/generate-cover
//   body: { kind: 'collection' | 'item', id: string }
//   → generates an AAIF-branded cover via @gatewaze-modules/ai, uploads it to
//     storage, writes the public URL onto the row (cover_image_url /
//     featured_image_url), and returns { url }.

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { makeResourceCoverGenerator } from '../lib/cover-image.js';

const STORAGE_BUCKET = process.env.HOST_MEDIA_BUCKET ?? 'media';

export async function registerRoutes(app, _ctx) {
  const url = process.env.SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
  if (!url || !serviceKey) {
    console.warn('[resources] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — cover-image route disabled');
    return;
  }

  const service = createClient(url, serviceKey, { auth: { persistSession: false } });
  const generateCover = makeResourceCoverGenerator({ supabase: service });

  const router = Router();

  // Verify the caller is an active admin using their own bearer token.
  async function requireAdmin(req, res) {
    const authHeader = req.headers?.authorization ?? '';
    if (!authHeader || !anonKey) {
      res.status(401).json({ error: 'unauthenticated' });
      return false;
    }
    const asUser = createClient(url, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data, error } = await asUser.rpc('is_admin');
    if (error || data !== true) {
      res.status(403).json({ error: 'admin_required' });
      return false;
    }
    return true;
  }

  router.post('/generate-cover', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const kind = req.body?.kind;
    const id = req.body?.id;
    if ((kind !== 'collection' && kind !== 'item') || typeof id !== 'string' || !id) {
      res.status(400).json({ error: "body must be { kind: 'collection' | 'item', id: string }" });
      return;
    }

    try {
      // Build the prompt inputs (title / subtitle / topics) from the row.
      let input;
      if (kind === 'collection') {
        const { data: col } = await service
          .from('sr_collections')
          .select('id, name, description')
          .eq('id', id)
          .maybeSingle();
        if (!col) { res.status(404).json({ error: 'collection_not_found' }); return; }
        const { data: cats } = await service
          .from('sr_categories').select('name').eq('collection_id', id).order('sort_order', { ascending: true });
        input = {
          kind: 'collection',
          id,
          title: col.name ?? '',
          subtitle: col.description ?? '',
          topics: (cats ?? []).map((c) => c.name).filter(Boolean).join(', '),
        };
      } else {
        const { data: item } = await service
          .from('sr_items')
          .select('id, title, subtitle, collection:sr_collections(name), category:sr_categories(name), sections:sr_sections(heading, sort_order)')
          .eq('id', id)
          .maybeSingle();
        if (!item) { res.status(404).json({ error: 'item_not_found' }); return; }
        const col = Array.isArray(item.collection) ? item.collection[0] : item.collection;
        const cat = Array.isArray(item.category) ? item.category[0] : item.category;
        const headings = (item.sections ?? [])
          .slice()
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
          .map((s) => s.heading)
          .filter(Boolean);
        input = {
          kind: 'item',
          id,
          title: item.title ?? '',
          // Prefix the item subtitle with its collection theme so the model
          // knows the parent context (e.g. "Conference Recap") for a specific
          // item title (e.g. "Bengaluru 2026").
          subtitle: [col?.name ? `Part of ${col.name}.` : '', item.subtitle ?? ''].filter(Boolean).join(' ').trim(),
          // Lead topics with the collection theme + category so the metaphor
          // reflects what kind of resource this is, then the section headings.
          topics: [col?.name, cat?.name, ...headings].filter(Boolean).join(', '),
        };
      }

      const { storage_path } = await generateCover(input);

      // Storage path → public URL. SUPABASE_URL is the INTERNAL docker
      // hostname (supabase-kong:8000) which the browser/portal can't resolve,
      // so build the URL from the EXTERNAL SUPABASE_PUBLIC_URL (falls back to
      // SUPABASE_URL on cloud envs where they're the same). Mirrors
      // host-media's buildPublicUrl.
      const publicBase = (process.env.SUPABASE_PUBLIC_URL || url).replace(/\/+$/, '');
      const publicUrl = `${publicBase}/storage/v1/object/public/${STORAGE_BUCKET}/${storage_path}`;

      const table = kind === 'collection' ? 'sr_collections' : 'sr_items';
      const column = kind === 'collection' ? 'cover_image_url' : 'featured_image_url';
      const { error: upErr } = await service.from(table).update({ [column]: publicUrl }).eq('id', id);
      if (upErr) { res.status(500).json({ error: `write_failed: ${upErr.message}` }); return; }

      res.json({ url: publicUrl, storage_path });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[resources] generate-cover failed:', message);
      // no_image_prompt (use-case not bound) surfaces as a 503 so the admin UI
      // can show a clear "cover generation not configured" message.
      const status = message.startsWith('no_image_prompt') ? 503 : 500;
      res.status(status).json({ error: message });
    }
  });

  app.use('/api/modules/resources', router);
  console.log('[resources] cover-image route registered');
}
