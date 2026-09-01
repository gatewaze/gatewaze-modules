-- ============================================================================
-- Module: event-speakers
-- Migration: 018_promo_kit_slide_deck
-- Description: Personalized speaker slide deck (PPTX, Google-Slides
--              compatible) generated with each promo kit — the event's plain
--              deck template with a branded title slide (the kit's landscape
--              card) and the talk/speaker pre-inserted on slide 2.
-- ============================================================================

ALTER TABLE public.speaker_promo_kits
  ADD COLUMN IF NOT EXISTS deck_storage_path text;
