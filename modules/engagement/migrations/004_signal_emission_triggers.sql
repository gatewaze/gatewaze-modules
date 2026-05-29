-- ============================================================================
-- Module: engagement
-- Migration: 004_signal_emission_triggers
-- Description: Source-module triggers that emit engagement signals via
--              emit_engagement_signal(). Each trigger is wrapped in
--              `IF EXISTS` guards so the engagement module can be installed
--              before or after any of the source modules.
--
--              Triggers installed:
--                - events_registrations INSERT → event.registered
--                - events_registrations UPDATE checked_in_at → event.attended
--                - calendars_members INSERT → calendar.joined
--                - calendars_members UPDATE confirmed_at → calendar.confirmed
--                - event_media INSERT → media.contributed
--                - events_speakers UPDATE participation_status='attended' → talk.delivered
--
--              Per spec-engagement-module.md §6.
-- ============================================================================

-- ==========================================================================
-- events_registrations: event.registered + event.attended
-- ==========================================================================
-- event_id (was 005_fix_trigger_event_columns): events_registrations' uuid FK
-- column is event_id, not the non-existent event_uuid the original referenced.
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

-- ==========================================================================
-- calendars_members: calendar.joined + calendar.confirmed
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.emit_calendar_join_signal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.person_id IS NULL THEN RETURN NEW; END IF;
  PERFORM public.emit_engagement_signal(
    'calendar.joined',
    NEW.person_id,
    jsonb_build_object(
      'calendar_id', NEW.calendar_id,
      'source_module', 'calendars',
      'source_record_id', NEW.id
    )
  );
  RETURN NEW;
EXCEPTION WHEN undefined_function THEN
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.emit_calendar_confirm_signal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.confirmed_at IS NOT NULL AND (OLD.confirmed_at IS NULL) THEN
    PERFORM public.emit_engagement_signal(
      'calendar.confirmed',
      NEW.person_id,
      jsonb_build_object(
        'calendar_id', NEW.calendar_id,
        'source_module', 'calendars',
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
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='calendars_members') THEN
    DROP TRIGGER IF EXISTS calendars_members_engagement_join ON public.calendars_members;
    CREATE TRIGGER calendars_members_engagement_join
      AFTER INSERT ON public.calendars_members
      FOR EACH ROW EXECUTE FUNCTION public.emit_calendar_join_signal();

    DROP TRIGGER IF EXISTS calendars_members_engagement_confirm ON public.calendars_members;
    CREATE TRIGGER calendars_members_engagement_confirm
      AFTER UPDATE OF confirmed_at ON public.calendars_members
      FOR EACH ROW EXECUTE FUNCTION public.emit_calendar_confirm_signal();
  END IF;
END $$;

-- ==========================================================================
-- events_media: media.contributed (only when uploaded by a non-admin person)
--
-- events_media schema (from event-media module):
--   id, event_id (uuid), url, file_type, uploaded_by (uuid)
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.emit_media_contribution_signal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.uploaded_by IS NULL THEN RETURN NEW; END IF;
  PERFORM public.emit_engagement_signal(
    'media.contributed',
    NEW.uploaded_by,
    jsonb_build_object(
      'event_id', NEW.event_id,
      'source_module', 'event-media',
      'source_record_id', NEW.id
    )
  );
  RETURN NEW;
EXCEPTION WHEN undefined_function THEN
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='events_media') THEN
    DROP TRIGGER IF EXISTS events_media_engagement_signal ON public.events_media;
    CREATE TRIGGER events_media_engagement_signal
      AFTER INSERT ON public.events_media
      FOR EACH ROW EXECUTE FUNCTION public.emit_media_contribution_signal();
  END IF;
END $$;

-- ==========================================================================
-- events_speakers: talk.submitted + talk.accepted + talk.delivered
-- ==========================================================================
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

-- ==========================================================================
-- conversations_messages: conversations.posted
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.emit_conversation_post_signal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_calendar_id uuid;
  v_event_id uuid;
BEGIN
  SELECT calendar_id, event_id INTO v_calendar_id, v_event_id
  FROM public.conversations WHERE id = NEW.conversation_id;

  PERFORM public.emit_engagement_signal(
    'conversations.posted',
    NEW.person_id,
    jsonb_build_object(
      'calendar_id', v_calendar_id,
      'event_id', v_event_id,
      'source_module', 'conversations',
      'source_record_id', NEW.id
    )
  );
  RETURN NEW;
EXCEPTION WHEN undefined_function THEN
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='conversations_messages') THEN
    DROP TRIGGER IF EXISTS conversations_messages_engagement_signal ON public.conversations_messages;
    CREATE TRIGGER conversations_messages_engagement_signal
      AFTER INSERT ON public.conversations_messages
      FOR EACH ROW EXECUTE FUNCTION public.emit_conversation_post_signal();
  END IF;
END $$;
