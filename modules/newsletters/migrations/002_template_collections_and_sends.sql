-- ============================================================================
-- Module: newsletters
-- Migration: 002_template_collections_and_sends
-- Description: Add template collections, output variants, and newsletter sending
-- ============================================================================

-- ============================================================================
-- 1. Template Collections
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.newsletters_template_collections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            text NOT NULL UNIQUE,
  description     text,
  is_default      boolean NOT NULL DEFAULT false,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.newsletters_template_collections IS 'Named template collections for different newsletter types (community, members, etc.)';

-- Only one default collection allowed
CREATE UNIQUE INDEX IF NOT EXISTS idx_template_collections_default
  ON public.newsletters_template_collections (is_default) WHERE is_default = true;

CREATE TRIGGER newsletters_template_collections_updated_at
  BEFORE UPDATE ON public.newsletters_template_collections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 2. Add collection_id + variant_key to block templates
-- ============================================================================

ALTER TABLE public.newsletters_block_templates
  ADD COLUMN IF NOT EXISTS collection_id uuid REFERENCES public.newsletters_template_collections(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS variant_key text NOT NULL DEFAULT 'html_template',
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

-- A block template is unique per (collection, block_type, variant_key)
CREATE UNIQUE INDEX IF NOT EXISTS idx_block_templates_unique
  ON public.newsletters_block_templates (collection_id, block_type, variant_key);

-- ============================================================================
-- 3. Add collection_id + variant_key to brick templates
-- ============================================================================

ALTER TABLE public.newsletters_brick_templates
  ADD COLUMN IF NOT EXISTS collection_id uuid REFERENCES public.newsletters_template_collections(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS variant_key text NOT NULL DEFAULT 'html_template',
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_brick_templates_unique
  ON public.newsletters_brick_templates (collection_id, brick_type, variant_key);

-- ============================================================================
-- 4. Add collection_id to editions
-- ============================================================================

ALTER TABLE public.newsletters_editions
  ADD COLUMN IF NOT EXISTS collection_id uuid REFERENCES public.newsletters_template_collections(id);

-- ============================================================================
-- 5. Create default collection and backfill
-- ============================================================================

INSERT INTO public.newsletters_template_collections (name, slug, description, is_default)
VALUES ('Default', 'default', 'Default template collection', true)
ON CONFLICT (slug) DO NOTHING;

-- Backfill existing block templates into the default collection
UPDATE public.newsletters_block_templates
SET collection_id = (SELECT id FROM public.newsletters_template_collections WHERE slug = 'default')
WHERE collection_id IS NULL;

-- Backfill existing brick templates into the default collection
UPDATE public.newsletters_brick_templates
SET collection_id = (SELECT id FROM public.newsletters_template_collections WHERE slug = 'default')
WHERE collection_id IS NULL;

-- Backfill existing editions into the default collection
UPDATE public.newsletters_editions
SET collection_id = (SELECT id FROM public.newsletters_template_collections WHERE slug = 'default')
WHERE collection_id IS NULL;

-- ============================================================================
-- 6. Newsletter Sends (requires bulk-emailing module for actual sending)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.newsletter_sends (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id          uuid NOT NULL REFERENCES public.newsletters_editions(id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed')),
  subject             text NOT NULL,
  preheader           text,
  from_address        text NOT NULL,
  from_name           text,
  adapter_id          text NOT NULL DEFAULT 'html',
  collection_id       uuid REFERENCES public.newsletters_template_collections(id),
  list_ids            text[] NOT NULL DEFAULT '{}',
  schedule_type       text NOT NULL DEFAULT 'immediate'
                      CHECK (schedule_type IN ('immediate', 'scheduled')),
  scheduled_at        timestamptz,
  started_at          timestamptz,
  completed_at        timestamptz,
  total_recipients    integer NOT NULL DEFAULT 0,
  sent_count          integer NOT NULL DEFAULT 0,
  failed_count        integer NOT NULL DEFAULT 0,
  rendered_html       text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.newsletter_sends IS 'Newsletter send jobs with scheduling and delivery tracking';

CREATE INDEX IF NOT EXISTS idx_newsletter_sends_status
  ON public.newsletter_sends (status);
CREATE INDEX IF NOT EXISTS idx_newsletter_sends_scheduled
  ON public.newsletter_sends (scheduled_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_newsletter_sends_edition
  ON public.newsletter_sends (edition_id);

CREATE TRIGGER newsletter_sends_updated_at
  BEFORE UPDATE ON public.newsletter_sends
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 7. RLS for new tables
-- ============================================================================

ALTER TABLE public.newsletters_template_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletter_sends ENABLE ROW LEVEL SECURITY;

-- Template collections: authenticated read, admin write
CREATE POLICY "newsletters_template_collections_select"
  ON public.newsletters_template_collections FOR SELECT TO authenticated USING (true);
CREATE POLICY "newsletters_template_collections_insert"
  ON public.newsletters_template_collections FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "newsletters_template_collections_update"
  ON public.newsletters_template_collections FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "newsletters_template_collections_delete"
  ON public.newsletters_template_collections FOR DELETE TO authenticated USING (public.is_admin());

-- Newsletter sends: authenticated read, admin write
CREATE POLICY "newsletter_sends_select"
  ON public.newsletter_sends FOR SELECT TO authenticated USING (true);
CREATE POLICY "newsletter_sends_insert"
  ON public.newsletter_sends FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "newsletter_sends_update"
  ON public.newsletter_sends FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "newsletter_sends_delete"
  ON public.newsletter_sends FOR DELETE TO authenticated USING (public.is_admin());
