-- ============================================================================
-- Module: bulk-emailing
-- Migration: 019_event_reminder_lead_hours
-- Description: Lifecycle reminders. The Comms tab already stores a per-event
-- reminder email (reminder_email_* on events_communication_settings) but there
-- was no scheduler — an admin had to fire it manually. Add a configurable lead
-- time so a worker cron can send the reminder automatically that many hours
-- before event_start (default 24h). reminder_email_sent_at (existing) guards
-- against double-send.
-- ============================================================================

ALTER TABLE public.events_communication_settings
  ADD COLUMN IF NOT EXISTS reminder_email_lead_hours integer NOT NULL DEFAULT 24;

COMMENT ON COLUMN public.events_communication_settings.reminder_email_lead_hours IS
  'Hours before event_start to auto-send the reminder email (dispatch-event-reminders cron). Default 24.';
