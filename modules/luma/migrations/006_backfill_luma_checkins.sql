-- ============================================================================
-- Module: luma
-- Migration: 006_backfill_luma_checkins
-- Description: The Luma CSV import stored each guest's check-in time on
--              integrations_luma_event_registrations.luma_checked_in_at but
--              never copied it to the registration it created, so every
--              Luma-sourced events_registrations row had checked_in = false.
--              The importers now record check-ins going forward; this copies
--              the ones already captured. Only empty checked_in_at values are
--              filled, so it is safe to re-run and never overwrites a
--              check-in recorded another way. The UPDATE fires the
--              engagement module's event.attended trigger where installed.
-- ============================================================================

UPDATE public.events_registrations er
SET checked_in = true,
    checked_in_at = l.luma_checked_in_at
FROM public.integrations_luma_event_registrations l
WHERE l.created_registration_id = er.id
  AND l.luma_checked_in_at IS NOT NULL
  AND er.checked_in_at IS NULL;
