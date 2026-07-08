-- ============================================================================
-- Module: blog
-- Migration: 008_blog_authors
-- Description: First-class blog authors. A `blog_authors` table carries public
--              display identity (slug, name, denormalised avatar) and bridges
--              to the platform identity system via `person_id`. `blog_posts`
--              gains an additive `blog_author_id` FK (the legacy opaque
--              `author_id` system UUID is left untouched — no data migration).
--              A guarded trigger keeps the denormalised author fields fresh
--              when a linked person's name/avatar changes.
-- Spec: gatewaze-environments/specs/spec-blog-authors-module.md §4, §6.6
-- ============================================================================

-- Authors ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.blog_authors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          varchar(200) NOT NULL UNIQUE,
  display_name  text NOT NULL,
  -- Identity bridge. Nullable so the blog module works even where the identity
  -- stack (people) isn't installed; the FK is added inside a guarded block.
  person_id     uuid,
  avatar_url    text,
  bio           text,
  -- The source site the author was discovered on (also the collision-suffix
  -- seed for slug disambiguation — see scraper).
  source_url    text,
  is_external   boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.blog_authors IS
  'Blog authors: public display identity + optional bridge to public.people (person_id).';

CREATE INDEX IF NOT EXISTS idx_blog_authors_person ON public.blog_authors (person_id);

CREATE TRIGGER blog_authors_updated_at
  BEFORE UPDATE ON public.blog_authors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Guarded FK to public.people (present on any full install; guarded for safety).
DO $$
BEGIN
  IF to_regclass('public.people') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'blog_authors_person_id_fkey'
     ) THEN
    ALTER TABLE public.blog_authors
      ADD CONSTRAINT blog_authors_person_id_fkey
      FOREIGN KEY (person_id) REFERENCES public.people (id) ON DELETE SET NULL;
  END IF;
END $$;

-- Posts → authors (additive; author_id is left untouched) ----------------------
ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS blog_author_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blog_posts_blog_author_id_fkey') THEN
    ALTER TABLE public.blog_posts
      ADD CONSTRAINT blog_posts_blog_author_id_fkey
      FOREIGN KEY (blog_author_id) REFERENCES public.blog_authors (id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_blog_posts_blog_author ON public.blog_posts (blog_author_id);

-- Denormalisation refresh: people → blog_authors (spec §6.6) -------------------
-- blog_authors.display_name / avatar_url are denormalised from the linked
-- person. The refresh helper below is SECURITY DEFINER (so it can be invoked
-- from other module RPCs) and re-syncs a single author row from its person.
-- NOTE: rather than an AFTER-UPDATE trigger on the core `people` table (which
-- module migrations, running as gatewaze_module_writer, may not own), the
-- refresh is invoked at claim time by onboarding.blog_claim_author — the moment
-- a real name/avatar first diverges from the scraped one. Ongoing profile edits
-- can be re-synced by calling this helper; a periodic sweep is a future item.
CREATE OR REPLACE FUNCTION public.blog_author_refresh_from_person(p_blog_author_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.blog_authors ba
     SET display_name = COALESCE(
           NULLIF(p.attributes->>'display_name', ''),
           NULLIF(TRIM(CONCAT_WS(' ', p.attributes->>'first_name', p.attributes->>'last_name')), ''),
           ba.display_name),
         avatar_url   = COALESCE(p.avatar_url, ba.avatar_url),
         updated_at   = now()
    FROM public.people p
   WHERE ba.id = p_blog_author_id AND ba.person_id = p.id;
END $$;
