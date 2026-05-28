-- ============================================================================
-- Module: badge-scanning
-- Migration: 001_badge_scanning_event_columns
-- Description: Add badge-related columns to core events_registrations and
--              events_attendance tables. These columns were previously part
--              of the core table definitions.
-- ============================================================================

-- ==========================================================================
-- 1. events_registrations — badge columns
-- ==========================================================================
ALTER TABLE public.events_registrations
  ADD COLUMN IF NOT EXISTS badge_print_status   text,
  ADD COLUMN IF NOT EXISTS badge_printed_count  integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_printed_at      timestamptz,
  ADD COLUMN IF NOT EXISTS badge_generated      boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS badge_generated_at   timestamptz,
  ADD COLUMN IF NOT EXISTS badge_sent_via_email boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS badge_sent_at        timestamptz;

-- ==========================================================================
-- 2. events_attendance — badge columns
-- ==========================================================================
ALTER TABLE public.events_attendance
  ADD COLUMN IF NOT EXISTS badge_printed_on_site boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS badge_printed_at      timestamptz;
