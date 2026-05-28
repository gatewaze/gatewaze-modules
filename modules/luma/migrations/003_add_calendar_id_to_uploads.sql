-- ============================================================================
-- Module: luma
-- Migration: 003_add_calendar_id_to_uploads
-- Description: Adds a calendar_id FK column to integrations_luma_csv_uploads
--              so the admin UI can filter uploads by the Gatewaze-side
--              calendar UUID. The existing luma_calendar_id column still
--              stores the Luma-side string ID for reference.
-- ============================================================================

-- Soft reference to calendars(id). No hard FK so luma doesn't
-- gain a build-time dep on the calendars module (calendars is optional).
ALTER TABLE public.integrations_luma_csv_uploads
  ADD COLUMN IF NOT EXISTS calendar_id uuid;

CREATE INDEX IF NOT EXISTS idx_integrations_luma_csv_uploads_calendar
  ON public.integrations_luma_csv_uploads (calendar_id)
  WHERE calendar_id IS NOT NULL;

-- Backfill: resolve the Gatewaze calendar uuid via the existing
-- luma_calendar_id column. Only runs if the calendars table exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='calendars') THEN
    UPDATE public.integrations_luma_csv_uploads u
    SET calendar_id = c.id
    FROM public.calendars c
    WHERE u.calendar_id IS NULL
      AND u.luma_calendar_id IS NOT NULL
      AND c.luma_calendar_id = u.luma_calendar_id;
  END IF;
END $$;

COMMENT ON COLUMN public.integrations_luma_csv_uploads.calendar_id IS
  'Gatewaze-side calendar UUID. Soft reference to calendars(id). The '
  'luma_calendar_id column still holds the Luma-side string identifier.';
