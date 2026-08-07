-- ============================================================================
-- Module: event-speakers
-- Migration: 017_promo_kit_confirmed_email
-- Description: The speaker-confirmed email now sends from the promo-kit
--              worker AFTER the kit is built, so the kit zip can ride along
--              as an attachment (at admin-confirm time the kit doesn't exist
--              yet). Stamp column makes the send idempotent across sweep
--              retries/regenerations.
-- ============================================================================

ALTER TABLE public.speaker_promo_kits
  ADD COLUMN IF NOT EXISTS confirmed_email_sent_at timestamptz;
