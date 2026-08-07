-- ============================================================================
-- Module: event-speakers
-- Migration: 013_speaker_promo_kits
-- Description: Per-talk speaker promo kit — the generated bundle a confirmed
--              speaker downloads/copies from the portal: umami tracking link,
--              four AI-written post variants, rendered social card images, and
--              the assembled zip. One row per talk; the promo-kit-sweep cron
--              enqueues generation for confirmed talks of upcoming events and
--              the generate-promo-kit worker fills the row in.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.speaker_promo_kits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  talk_id uuid NOT NULL UNIQUE REFERENCES public.events_talks(id) ON DELETE CASCADE,
  event_uuid uuid REFERENCES public.events(id) ON DELETE CASCADE,
  -- events_speaker_profiles id of the talk's primary speaker (also the
  -- utm_campaign value on the tracking link, matching the legacy attribution
  -- join on event_registrations.utm_campaign).
  speaker_profile_id uuid,

  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'generating', 'ready', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  error text,

  -- Tracking link (umami provider, served at https://<domain>/go/<slug>).
  tracking_slug text,
  tracking_short_url text,
  tracking_destination_url text,
  tracking_redirect_id uuid,

  -- Promo text: { options: [{key, label, body}], mention_note? } from the
  -- speaker-promo-posts recipe. Kept separately failable so a recipe outage
  -- still ships cards + link.
  ai_run_id uuid,
  promo_text jsonb,
  promo_text_status text NOT NULL DEFAULT 'pending'
    CHECK (promo_text_status IN ('pending', 'ready', 'failed')),
  promo_text_error text,

  -- Rendered cards: [{format, storage_path, width, height}] in the media
  -- bucket. Zip bundles cards + text + link.
  cards jsonb,
  zip_storage_path text,

  template_version text,
  generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_speaker_promo_kits_status
  ON public.speaker_promo_kits(status);
CREATE INDEX IF NOT EXISTS idx_speaker_promo_kits_event
  ON public.speaker_promo_kits(event_uuid);

ALTER TABLE public.speaker_promo_kits ENABLE ROW LEVEL SECURITY;

-- Service-role only. The portal reads kits through a server-side route that
-- authenticates the speaker by their talk edit_token (the same capability
-- token as the rest of the speaker checklist); admin surfaces go through
-- service-role endpoints. No anon/authenticated policies on purpose: the
-- promo_text/cards of an unpublished speaker must not be listable.
DROP POLICY IF EXISTS speaker_promo_kits_service ON public.speaker_promo_kits;
CREATE POLICY speaker_promo_kits_service ON public.speaker_promo_kits
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- updated_at maintenance, matching the module's existing trigger convention.
CREATE OR REPLACE FUNCTION public.speaker_promo_kits_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_speaker_promo_kits_updated_at ON public.speaker_promo_kits;
CREATE TRIGGER trg_speaker_promo_kits_updated_at
  BEFORE UPDATE ON public.speaker_promo_kits
  FOR EACH ROW EXECUTE FUNCTION public.speaker_promo_kits_touch_updated_at();
