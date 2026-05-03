-- ============================================================================
-- Migration: sites_010_rename_theme_kinds
-- Description: Counterpart to templates_013. Renames theme_kind values on
--              the sites side and the pages_host_registrations.
--              accepted_theme_kinds array, plus the three sites trigger
--              functions that reference the values.
--
--              After this migration, sites.theme_kind is constrained to
--              'website' alone (sites are uniformly website-kind in the
--              new model — newsletters/events/calendars use 'email' on
--              their libraries instead). Any pre-existing sites with
--              theme_kind='html' are migrated to 'website' (force-coerce
--              — the html-site renderer was never built).
-- ============================================================================

-- ==========================================================================
-- 1. Drop old CHECK on sites.theme_kind (must precede UPDATE — old CHECK
--    forbids the new vocabulary)
-- ==========================================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'sites'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%theme_kind%html%nextjs%'
  LOOP
    EXECUTE format('ALTER TABLE public.sites DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- ==========================================================================
-- 2. Rename sites.theme_kind data
-- ==========================================================================
-- All sites coerce to 'website'. The trigger sites_theme_kind_immutable
-- (created in 006) blocks UPDATE OF theme_kind, so we have to disable it
-- for the rename.

ALTER TABLE public.sites DISABLE TRIGGER sites_theme_kind_immutable;

UPDATE public.sites SET theme_kind = 'website' WHERE theme_kind IN ('html', 'nextjs');

ALTER TABLE public.sites ENABLE TRIGGER sites_theme_kind_immutable;

-- ==========================================================================
-- 3. Add new CHECK and DEFAULT on sites.theme_kind (website only)
-- ==========================================================================

ALTER TABLE public.sites
  ADD CONSTRAINT sites_theme_kind_check
  CHECK (theme_kind = 'website');

ALTER TABLE public.sites ALTER COLUMN theme_kind SET DEFAULT 'website';

-- ==========================================================================
-- 4. Rename pages_host_registrations.accepted_theme_kinds data + CHECK
-- ==========================================================================
-- Drop the named CHECK first (it forbids the new vocabulary), then rewrite
-- each row's array element-wise, then re-establish the CHECK.

ALTER TABLE public.pages_host_registrations
  DROP CONSTRAINT IF EXISTS pages_host_registrations_accepted_theme_kinds_valid;

UPDATE public.pages_host_registrations
   SET accepted_theme_kinds = ARRAY(
     SELECT CASE elem
              WHEN 'html'   THEN 'email'
              WHEN 'nextjs' THEN 'website'
              ELSE elem
            END
     FROM unnest(accepted_theme_kinds) AS elem
   )
 WHERE 'html' = ANY(accepted_theme_kinds) OR 'nextjs' = ANY(accepted_theme_kinds);

ALTER TABLE public.pages_host_registrations
  ADD CONSTRAINT pages_host_registrations_accepted_theme_kinds_valid
  CHECK (accepted_theme_kinds <@ ARRAY['email','website']::text[]);

ALTER TABLE public.pages_host_registrations
  ALTER COLUMN accepted_theme_kinds SET DEFAULT ARRAY['email']::text[];

-- ==========================================================================
-- 5. Replace trigger functions with renamed value checks
-- ==========================================================================

-- 4a. sites_publishing_target_matches_kind (was 'nextjs' -> now 'website')
CREATE OR REPLACE FUNCTION public.sites_publishing_target_matches_kind()
RETURNS trigger AS $$
DECLARE
  v_target_kind text;
BEGIN
  v_target_kind := NEW.publishing_target->>'kind';

  IF NEW.theme_kind = 'website' THEN
    IF v_target_kind IS DISTINCT FROM 'external' AND v_target_kind IS DISTINCT FROM 'portal' THEN
      RAISE EXCEPTION 'invalid_publishing_target_for_website: theme_kind=website requires publishing_target.kind in (external, portal) (got %)',
        COALESCE(v_target_kind, '<null>')
        USING ERRCODE = 'check_violation';
    END IF;
    -- portal target needs no publisherId; external still does.
    IF v_target_kind = 'external' AND (NEW.publishing_target->>'publisherId') IS NULL THEN
      RAISE EXCEPTION 'invalid_publishing_target_for_website: external publishing requires publishing_target.publisherId'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4b. pages_content_matches_kind
-- Sites are now uniformly website-kind, so the website branch is the only
-- live one for site host_kind. Keep the trigger for forward safety.
CREATE OR REPLACE FUNCTION public.pages_content_matches_kind()
RETURNS trigger AS $$
DECLARE
  v_site_kind text;
BEGIN
  IF NEW.host_kind = 'site' AND NEW.host_id IS NOT NULL THEN
    SELECT theme_kind INTO v_site_kind FROM public.sites WHERE id = NEW.host_id;
    IF v_site_kind = 'website' THEN
      IF NEW.content IS NULL OR NEW.content_schema_version IS NULL THEN
        RAISE EXCEPTION 'invalid_pages_content_for_theme_kind: website site requires content AND content_schema_version'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4c. page_blocks_only_for_html_pages -> renamed semantically.
-- Sites are always website-kind now, so this guard always fires for
-- site host_kind: page_blocks are forbidden for site pages, period.
-- Other host_kinds (newsletters/events/calendars) keep using page_blocks.
CREATE OR REPLACE FUNCTION public.page_blocks_only_for_html_pages()
RETURNS trigger AS $$
DECLARE
  v_host_kind text;
  v_host_id   uuid;
  v_site_kind text;
BEGIN
  SELECT host_kind, host_id INTO v_host_kind, v_host_id
    FROM public.pages WHERE id = NEW.page_id;

  IF v_host_kind = 'site' AND v_host_id IS NOT NULL THEN
    SELECT theme_kind INTO v_site_kind FROM public.sites WHERE id = v_host_id;
    IF v_site_kind = 'website' THEN
      RAISE EXCEPTION 'page_blocks_forbidden_for_website_site: page % is on a website site; use pages.content JSONB instead', NEW.page_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4d. page_block_bricks counterpart
CREATE OR REPLACE FUNCTION public.page_block_bricks_only_for_html_pages()
RETURNS trigger AS $$
DECLARE
  v_page_id   uuid;
  v_host_kind text;
  v_host_id   uuid;
  v_site_kind text;
BEGIN
  SELECT page_id INTO v_page_id FROM public.page_blocks WHERE id = NEW.page_block_id;
  IF v_page_id IS NULL THEN
    RAISE EXCEPTION 'page_block_bricks_orphan: page_block % does not exist', NEW.page_block_id;
  END IF;
  SELECT host_kind, host_id INTO v_host_kind, v_host_id
    FROM public.pages WHERE id = v_page_id;
  IF v_host_kind = 'site' AND v_host_id IS NOT NULL THEN
    SELECT theme_kind INTO v_site_kind FROM public.sites WHERE id = v_host_id;
    IF v_site_kind = 'website' THEN
      RAISE EXCEPTION 'page_block_bricks_forbidden_for_website_site'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
