-- ============================================================================
-- Module: offers
-- Migration: 002_legacy_parity
-- Description: Add the columns the offer tracking function already writes,
--              create the downloadable-resources and download-log tables the
--              admin and the download-token function already use, and stop
--              offer interactions being readable by every signed-in member.
--
-- Context: integrations-track-offer inserts workspace, offer_partner,
-- offer_type and customer_id, none of which existed. offerResourceService and
-- platform-generate-download-token read resource and log tables that no
-- migration created, so gated downloads could not work.
-- ============================================================================

-- ==========================================================================
-- 1. integrations_offer_interactions
-- ==========================================================================
-- A derived copy of Customer.io offer events. offer_id is the offer SLUG.

ALTER TABLE public.integrations_offer_interactions
  ALTER COLUMN customer_cio_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS workspace     text,
  ADD COLUMN IF NOT EXISTS offer_partner text,
  ADD COLUMN IF NOT EXISTS offer_type    text,
  ADD COLUMN IF NOT EXISTS customer_id   bigint;

COMMENT ON COLUMN public.integrations_offer_interactions.workspace IS 'Brand the Customer.io event came from';
COMMENT ON COLUMN public.integrations_offer_interactions.offer_partner IS 'Sponsor or partner name';
COMMENT ON COLUMN public.integrations_offer_interactions.offer_type IS 'e.g. webinar, event, ebook, voucher';
COMMENT ON COLUMN public.integrations_offer_interactions.customer_id IS 'Legacy gatewaze-admin customers.id, kept for traceability';

-- Was readable by every signed-in member; it holds an email per interaction.
DROP POLICY IF EXISTS "integrations_offer_interactions_select" ON public.integrations_offer_interactions;
CREATE POLICY "integrations_offer_interactions_select"
  ON public.integrations_offer_interactions FOR SELECT TO authenticated
  USING (public.is_admin());

-- ==========================================================================
-- 2. integrations_offer_resources: files behind a gated offer
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.integrations_offer_resources (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id          text NOT NULL,
  file_id           text NOT NULL UNIQUE,
  name              text NOT NULL,
  description       text,
  storage_path      text NOT NULL,
  download_filename text NOT NULL,
  mime_type         text DEFAULT 'application/pdf',
  file_size_bytes   bigint,
  download_count    integer NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.integrations_offer_resources IS
  'Downloadable resources attached to an offer (eBooks, PDFs). offer_id is the offer slug.';
COMMENT ON COLUMN public.integrations_offer_resources.file_id IS
  'Identifier used in download requests';
COMMENT ON COLUMN public.integrations_offer_resources.storage_path IS
  'Path inside the downloads storage bucket';

CREATE INDEX IF NOT EXISTS idx_integrations_offer_resources_offer
  ON public.integrations_offer_resources (offer_id);

DROP TRIGGER IF EXISTS integrations_offer_resources_updated_at ON public.integrations_offer_resources;
CREATE TRIGGER integrations_offer_resources_updated_at
  BEFORE UPDATE ON public.integrations_offer_resources
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.integrations_offer_resources ENABLE ROW LEVEL SECURITY;

-- The download itself goes through platform-generate-download-token on the
-- service role. Storage paths are not public, so reads are admin only.
DROP POLICY IF EXISTS "integrations_offer_resources_admin_all" ON public.integrations_offer_resources;
CREATE POLICY "integrations_offer_resources_admin_all"
  ON public.integrations_offer_resources FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ==========================================================================
-- 3. integrations_download_logs: who downloaded what
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.integrations_download_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  file_id       text NOT NULL,
  file_path     text NOT NULL,
  offer_id      text,
  resource_id   uuid REFERENCES public.integrations_offer_resources(id) ON DELETE SET NULL,
  customer_id   bigint,
  downloaded_at timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.integrations_download_logs IS
  'One row per gated-content download';

CREATE INDEX IF NOT EXISTS idx_integrations_download_logs_offer
  ON public.integrations_download_logs (offer_id);
CREATE INDEX IF NOT EXISTS idx_integrations_download_logs_resource
  ON public.integrations_download_logs (resource_id);
CREATE INDEX IF NOT EXISTS idx_integrations_download_logs_email
  ON public.integrations_download_logs (lower(email));

-- Keep the cached download_count in step, as the original trigger did.
CREATE OR REPLACE FUNCTION public.integrations_offer_resources_bump_download_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.resource_id IS NOT NULL THEN
    UPDATE public.integrations_offer_resources
       SET download_count = download_count + 1
     WHERE id = NEW.resource_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.integrations_offer_resources_bump_download_count() FROM PUBLIC;

DROP TRIGGER IF EXISTS integrations_download_logs_bump_count ON public.integrations_download_logs;
CREATE TRIGGER integrations_download_logs_bump_count
  AFTER INSERT ON public.integrations_download_logs
  FOR EACH ROW EXECUTE FUNCTION public.integrations_offer_resources_bump_download_count();

ALTER TABLE public.integrations_download_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "integrations_download_logs_admin_all" ON public.integrations_download_logs;
CREATE POLICY "integrations_download_logs_admin_all"
  ON public.integrations_download_logs FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());
