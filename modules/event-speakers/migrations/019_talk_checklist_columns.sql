-- ============================================================================
-- Module: event-speakers
-- Migration: 019_talk_checklist_columns
-- Description: The five events_talks columns the speaker checklist and
--              confirm flow have ALWAYS written/read but no migration ever
--              declared (found while overhauling speaker comms):
--                - confirmed_at            (events-speaker-confirm writes it;
--                                           selecting it 400ed PostgREST, so
--                                           every emailed confirm link showed
--                                           "Invalid Link")
--                - presentation_storage_path / presentation_type
--                                          (checklist presentation upload)
--                - calendar_added_at       (Add-to-calendar completion stamp)
--                - tracking_link_copied_at (promo-kit "shared" stamp)
--              All additive and idempotent.
-- ============================================================================

ALTER TABLE public.events_talks
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS presentation_storage_path text,
  ADD COLUMN IF NOT EXISTS presentation_type text,
  ADD COLUMN IF NOT EXISTS calendar_added_at timestamptz,
  ADD COLUMN IF NOT EXISTS tracking_link_copied_at timestamptz;
