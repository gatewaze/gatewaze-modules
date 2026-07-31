-- Keep the related-content snapshot (related_embeddings) in sync with a
-- resource item's display fields.
--
-- related_embeddings stores a DENORMALISED copy of each item's href, title,
-- image_url and description for fast semantic retrieval (the /related-content
-- panel reads these directly). When an item is later re-slugged, retitled, or
-- given/changed a cover, that snapshot went stale — the panel showed a stale
-- title, a broken link (old slug) and no cover — because only a full re-embed
-- refreshed it, and a slug/cover change doesn't trigger one.
--
-- These display fields don't affect the embedding VECTOR (which is keyed on
-- embed_text), so we refresh them in place on UPDATE — cheap, no re-embed.
-- (A title change still warrants a re-embed for the vector; that remains the
-- embed worker's job. This only keeps what the card RENDERS correct.)

CREATE OR REPLACE FUNCTION public.sr_items_sync_related_embeddings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF to_regclass('public.related_embeddings') IS NULL THEN
    RETURN NEW;
  END IF;
  UPDATE public.related_embeddings e
     SET href        = '/resources/' || c.slug || '/' || NEW.slug,
         image_url   = NEW.featured_image_url,
         title       = NEW.title,
         description = NEW.subtitle
    FROM public.sr_collections c
   WHERE e.content_type = 'sr_item'
     AND e.content_id   = NEW.id
     AND c.id           = NEW.collection_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sr_items_sync_related ON public.sr_items;
CREATE TRIGGER trg_sr_items_sync_related
  AFTER UPDATE OF title, slug, subtitle, featured_image_url ON public.sr_items
  FOR EACH ROW
  EXECUTE FUNCTION public.sr_items_sync_related_embeddings();

-- One-time backfill of any already-stale rows (the trigger only fires on
-- future updates). Idempotent.
DO $backfill$
BEGIN
  IF to_regclass('public.related_embeddings') IS NOT NULL THEN
    UPDATE public.related_embeddings e
       SET href      = '/resources/' || c.slug || '/' || i.slug,
           image_url = i.featured_image_url,
           title     = i.title
      FROM public.sr_items i
      JOIN public.sr_collections c ON c.id = i.collection_id
     WHERE e.content_type = 'sr_item'
       AND e.content_id   = i.id
       AND (
         e.href IS DISTINCT FROM '/resources/' || c.slug || '/' || i.slug
         OR coalesce(e.image_url,'') IS DISTINCT FROM coalesce(i.featured_image_url,'')
         OR e.title IS DISTINCT FROM i.title
       );
  END IF;
END
$backfill$;
