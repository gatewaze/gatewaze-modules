-- ============================================================================
-- Module: engagement
-- Migration: 005_fix_trigger_event_columns
-- Description: Fixes the signal emission trigger functions to reference
--              events_registrations.event_id (the uuid FK) instead of the
--              non-existent er.event_uuid. Reapplies the triggers.
-- ============================================================================

-- emit_event_registration_signal
CREATE OR REPLACE FUNCTION public.emit_event_registration_signal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.person_id IS NULL OR NEW.event_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM public.emit_engagement_signal(
    'event.registered',
    NEW.person_id,
    jsonb_build_object(
      'event_id', NEW.event_id,
      'source_module', 'events',
      'source_record_id', NEW.id
    )
  );
  RETURN NEW;
EXCEPTION WHEN undefined_function THEN
  RETURN NEW;
END;
$$;

-- emit_event_attendance_signal
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
        'source_record_id', NEW.id
      )
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN undefined_function THEN
  RETURN NEW;
END;
$$;

-- Re-create the triggers to pick up the new function bodies. CREATE OR REPLACE
-- on the functions is enough — existing triggers will use the new body.
-- But also (re-)install the triggers in case they were never successfully
-- created previously due to the column error.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='events_registrations') THEN
    DROP TRIGGER IF EXISTS events_registrations_engagement_insert ON public.events_registrations;
    CREATE TRIGGER events_registrations_engagement_insert
      AFTER INSERT ON public.events_registrations
      FOR EACH ROW EXECUTE FUNCTION public.emit_event_registration_signal();

    DROP TRIGGER IF EXISTS events_registrations_engagement_attend ON public.events_registrations;
    CREATE TRIGGER events_registrations_engagement_attend
      AFTER UPDATE OF checked_in_at ON public.events_registrations
      FOR EACH ROW EXECUTE FUNCTION public.emit_event_attendance_signal();
  END IF;
END $$;

-- events_speakers.event_uuid → event_id too
CREATE OR REPLACE FUNCTION public.emit_speaker_signal_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.people_profile_id IS NULL THEN RETURN NEW; END IF;
  PERFORM public.emit_engagement_signal(
    'talk.submitted',
    NEW.people_profile_id,
    jsonb_build_object(
      'event_id', NEW.event_uuid,
      'source_module', 'event-speakers',
      'source_record_id', NEW.id
    )
  );
  RETURN NEW;
EXCEPTION WHEN undefined_function THEN
  RETURN NEW;
END;
$$;

-- events_speakers genuinely uses event_uuid (that's its FK column name per
-- the module's 001 migration), so no change to that reference. Re-declared
-- here for completeness and in case the original never installed.

CREATE OR REPLACE FUNCTION public.emit_speaker_signal_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.people_profile_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.status = 'confirmed' AND (OLD.status IS NULL OR OLD.status <> 'confirmed') THEN
    PERFORM public.emit_engagement_signal(
      'talk.accepted',
      NEW.people_profile_id,
      jsonb_build_object(
        'event_id', NEW.event_uuid,
        'source_module', 'event-speakers',
        'source_record_id', NEW.id
      )
    );
  END IF;

  IF NEW.participation_status = 'attended' AND (OLD.participation_status IS NULL OR OLD.participation_status <> 'attended') THEN
    PERFORM public.emit_engagement_signal(
      'talk.delivered',
      NEW.people_profile_id,
      jsonb_build_object(
        'event_id', NEW.event_uuid,
        'source_module', 'event-speakers',
        'source_record_id', NEW.id
      )
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN undefined_function THEN
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='events_speakers') THEN
    DROP TRIGGER IF EXISTS events_speakers_engagement_insert ON public.events_speakers;
    CREATE TRIGGER events_speakers_engagement_insert
      AFTER INSERT ON public.events_speakers
      FOR EACH ROW EXECUTE FUNCTION public.emit_speaker_signal_insert();

    DROP TRIGGER IF EXISTS events_speakers_engagement_status ON public.events_speakers;
    CREATE TRIGGER events_speakers_engagement_status
      AFTER UPDATE ON public.events_speakers
      FOR EACH ROW EXECUTE FUNCTION public.emit_speaker_signal_status();
  END IF;
END $$;
