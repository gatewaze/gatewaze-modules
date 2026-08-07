-- ============================================================================
-- Module: event-speakers
-- Migration: 021_presentation_reminders
-- Description: Scheduled "we still need your presentation" nudges for
--              confirmed speakers, mirroring the speaker_approved /
--              speaker_confirmed comms settings so organisers edit them in the
--              same place with the same template grammar.
--
--              Two differences from the other speaker emails:
--                * it is a SERIES — offsets (days before the event) live in
--                  speaker_presentation_reminder_offsets, default {14, 8};
--                * it is CONDITIONAL — only speakers whose talk still has no
--                  presentation_url and no presentation_storage_path get it.
--
--              speaker_presentation_reminders logs one row per (talk, offset)
--              so a reminder is sent at most once per offset even if the sweep
--              runs repeatedly, and so an organiser can see what went out.
-- ============================================================================

ALTER TABLE public.events_communication_settings
  ADD COLUMN IF NOT EXISTS speaker_presentation_reminder_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS speaker_presentation_reminder_subject text,
  ADD COLUMN IF NOT EXISTS speaker_presentation_reminder_content text,
  ADD COLUMN IF NOT EXISTS speaker_presentation_reminder_template_id uuid,
  ADD COLUMN IF NOT EXISTS speaker_presentation_reminder_from_key text,
  ADD COLUMN IF NOT EXISTS speaker_presentation_reminder_reply_to text,
  ADD COLUMN IF NOT EXISTS speaker_presentation_reminder_cc text,
  -- Days before event_start. Ordered largest→smallest by convention; the
  -- sweep treats each independently so order is cosmetic.
  ADD COLUMN IF NOT EXISTS speaker_presentation_reminder_offsets integer[]
    NOT NULL DEFAULT ARRAY[14, 8];

CREATE TABLE IF NOT EXISTS public.speaker_presentation_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  talk_id uuid NOT NULL REFERENCES public.events_talks(id) ON DELETE CASCADE,
  event_uuid uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  offset_days integer NOT NULL,
  recipient_email text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  -- One send per talk per offset. The sweep relies on this to stay idempotent
  -- under retries and overlapping ticks, not on a status column.
  CONSTRAINT speaker_presentation_reminders_once UNIQUE (talk_id, offset_days)
);

CREATE INDEX IF NOT EXISTS idx_speaker_presentation_reminders_event
  ON public.speaker_presentation_reminders (event_uuid);

ALTER TABLE public.speaker_presentation_reminders ENABLE ROW LEVEL SECURITY;

-- Service role (the worker) writes; active admins read for the comms UI.
-- No anon/authenticated access: this exposes speaker email addresses.
DROP POLICY IF EXISTS presentation_reminders_service ON public.speaker_presentation_reminders;
CREATE POLICY presentation_reminders_service ON public.speaker_presentation_reminders
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS presentation_reminders_admin_read ON public.speaker_presentation_reminders;
CREATE POLICY presentation_reminders_admin_read ON public.speaker_presentation_reminders
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.admin_profiles ap
    WHERE ap.user_id = auth.uid() AND ap.is_active = true
  ));
