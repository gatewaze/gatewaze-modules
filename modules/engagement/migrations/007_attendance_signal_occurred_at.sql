-- ============================================================================
-- Module: engagement
-- Migration: 007_attendance_signal_occurred_at
-- Description: event.attended signals now carry the registration's
--              checked_in_at as occurred_at. emit_engagement_signal falls
--              back to now() without it, so a check-in recorded after the
--              fact (a Luma CSV re-export, or luma migration 006's backfill)
--              was dated at the time it was recorded, not when the person
--              attended. Apply before luma 006 so the backfilled signals get
--              their real dates.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.emit_event_attendance_signal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.checked_in_at IS NOT NULL AND (OLD.checked_in_at IS NULL OR OLD.checked_in_at <> NEW.checked_in_at) THEN
    PERFORM public.emit_engagement_signal(
      'event.attended',
      NEW.person_id,
      jsonb_build_object(
        'event_id', NEW.event_id,
        'source_module', 'events',
        'source_record_id', NEW.id,
        'occurred_at', NEW.checked_in_at
      )
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN undefined_function THEN
  RETURN NEW;
END;
$$;
