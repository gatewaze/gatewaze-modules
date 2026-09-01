-- ============================================================================
-- Module: event-speakers
-- Migration: 015_promo_kit_admin_access
-- Description: Admin surfacing for speaker promo kits:
--   1. Active platform admins can read kits (the Speakers-tab modal) and
--      update them (the Regenerate action resets status='requested', which
--      the promo-kit sweep picks up).
--   2. speaker_promo_event_config — per-event overrides mapping promo-kit
--      generation to a template repo and/or a brand key, editable from the
--      event's Speakers tab. Unset fields fall back to the module-level
--      SPEAKER_CARDS_TEMPLATE_REPO config and the repo's mapping.json rules.
-- ============================================================================

-- ── 1. Admin access to kits ────────────────────────────────────────────────

DROP POLICY IF EXISTS speaker_promo_kits_admin_read ON public.speaker_promo_kits;
CREATE POLICY speaker_promo_kits_admin_read ON public.speaker_promo_kits
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.admin_profiles ap
    WHERE ap.user_id = auth.uid() AND ap.is_active
  ));

DROP POLICY IF EXISTS speaker_promo_kits_admin_update ON public.speaker_promo_kits;
CREATE POLICY speaker_promo_kits_admin_update ON public.speaker_promo_kits
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.admin_profiles ap
    WHERE ap.user_id = auth.uid() AND ap.is_active
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.admin_profiles ap
    WHERE ap.user_id = auth.uid() AND ap.is_active
  ));

-- ── 2. Per-event promo-kit config ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.speaker_promo_event_config (
  event_uuid uuid PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
  -- Overrides the module-level SPEAKER_CARDS_TEMPLATE_REPO for this event
  -- (https://github.com/<org>/<repo>[#ref], GitHub only — same validation
  -- as the module config; invalid values fall back to the module default).
  template_repo text,
  -- Pins this event to a brand key (brands/<key>.json in the template repo)
  -- instead of resolving through mapping.json rules.
  brand_key text CHECK (brand_key IS NULL OR brand_key ~ '^[A-Za-z0-9_-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.speaker_promo_event_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS speaker_promo_event_config_service ON public.speaker_promo_event_config;
CREATE POLICY speaker_promo_event_config_service ON public.speaker_promo_event_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS speaker_promo_event_config_admin ON public.speaker_promo_event_config;
CREATE POLICY speaker_promo_event_config_admin ON public.speaker_promo_event_config
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.admin_profiles ap
    WHERE ap.user_id = auth.uid() AND ap.is_active
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.admin_profiles ap
    WHERE ap.user_id = auth.uid() AND ap.is_active
  ));

DROP TRIGGER IF EXISTS trg_speaker_promo_event_config_updated_at ON public.speaker_promo_event_config;
CREATE TRIGGER trg_speaker_promo_event_config_updated_at
  BEFORE UPDATE ON public.speaker_promo_event_config
  FOR EACH ROW EXECUTE FUNCTION public.speaker_promo_kits_touch_updated_at();
