-- ============================================================================
-- Module: event-agenda
-- Migration: 001_event_agenda_tables
-- Description: Agenda tracks, entries, and entry-speaker junction tables.
--              Depends on event-speakers module for speaker_profiles and talks.
-- ============================================================================

-- ==========================================================================
-- 1. events_agenda_tracks
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.events_agenda_tracks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_uuid  uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  sort_order  integer DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_agenda_tracks_event ON public.events_agenda_tracks (event_uuid);

CREATE TRIGGER events_agenda_tracks_updated_at
  BEFORE UPDATE ON public.events_agenda_tracks
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 2. events_agenda_entries
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.events_agenda_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_uuid  uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  track_id    uuid REFERENCES public.events_agenda_tracks(id) ON DELETE SET NULL,
  title       text NOT NULL,
  description text,
  start_time  timestamptz,
  end_time    timestamptz,
  location    text,
  sort_order  integer DEFAULT 0,
  entry_type  text DEFAULT 'session'
    CHECK (entry_type IN ('session', 'break', 'spacer')),
  talk_id     uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_agenda_entries_event ON public.events_agenda_entries (event_uuid);
CREATE INDEX IF NOT EXISTS idx_events_agenda_entries_track ON public.events_agenda_entries (track_id);

CREATE TRIGGER events_agenda_entries_updated_at
  BEFORE UPDATE ON public.events_agenda_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Conditional FK: talk_id → events_talks (if speakers module installed)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'events_talks') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'events_agenda_entries_talk_id_fkey') THEN
      ALTER TABLE public.events_agenda_entries
        ADD CONSTRAINT events_agenda_entries_talk_id_fkey
        FOREIGN KEY (talk_id) REFERENCES public.events_talks(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- ==========================================================================
-- 3. events_agenda_entry_speakers (junction)
-- ==========================================================================

-- Only create if speakers module is installed
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'events_speaker_profiles') THEN
    CREATE TABLE IF NOT EXISTS public.events_agenda_entry_speakers (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agenda_entry_id uuid NOT NULL REFERENCES public.events_agenda_entries(id) ON DELETE CASCADE,
      speaker_id      uuid NOT NULL REFERENCES public.events_speaker_profiles(id) ON DELETE CASCADE,
      sort_order      integer DEFAULT 0,
      UNIQUE (agenda_entry_id, speaker_id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_agenda_entry_speakers_entry ON public.events_agenda_entry_speakers (agenda_entry_id);
    CREATE INDEX IF NOT EXISTS idx_events_agenda_entry_speakers_speaker ON public.events_agenda_entry_speakers (speaker_id);

    ALTER TABLE public.events_agenda_entry_speakers ENABLE ROW LEVEL SECURITY;

    -- RLS for agenda entry speakers
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'agenda_entry_speakers_select' AND tablename = 'events_agenda_entry_speakers') THEN
      CREATE POLICY "agenda_entry_speakers_select"
        ON public.events_agenda_entry_speakers FOR SELECT TO authenticated
        USING (EXISTS (
          SELECT 1 FROM public.events_agenda_entries eae
          WHERE eae.id = events_agenda_entry_speakers.agenda_entry_id
            AND public.can_admin_event(eae.event_uuid)
        ) OR public.is_admin());
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'agenda_entry_speakers_insert' AND tablename = 'events_agenda_entry_speakers') THEN
      CREATE POLICY "agenda_entry_speakers_insert"
        ON public.events_agenda_entry_speakers FOR INSERT TO authenticated
        WITH CHECK (EXISTS (
          SELECT 1 FROM public.events_agenda_entries eae
          WHERE eae.id = events_agenda_entry_speakers.agenda_entry_id
            AND public.can_admin_event(eae.event_uuid)
        ));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'agenda_entry_speakers_update' AND tablename = 'events_agenda_entry_speakers') THEN
      CREATE POLICY "agenda_entry_speakers_update"
        ON public.events_agenda_entry_speakers FOR UPDATE TO authenticated
        USING (EXISTS (
          SELECT 1 FROM public.events_agenda_entries eae
          WHERE eae.id = events_agenda_entry_speakers.agenda_entry_id
            AND public.can_admin_event(eae.event_uuid)
        ));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'agenda_entry_speakers_delete' AND tablename = 'events_agenda_entry_speakers') THEN
      CREATE POLICY "agenda_entry_speakers_delete"
        ON public.events_agenda_entry_speakers FOR DELETE TO authenticated
        USING (EXISTS (
          SELECT 1 FROM public.events_agenda_entries eae
          WHERE eae.id = events_agenda_entry_speakers.agenda_entry_id
            AND public.can_admin_event(eae.event_uuid)
        ));
    END IF;
  END IF;
END $$;

-- ==========================================================================
-- 4. RLS Policies for tracks and entries
-- ==========================================================================

ALTER TABLE public.events_agenda_tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_agenda_entries ENABLE ROW LEVEL SECURITY;

-- Agenda tracks
CREATE POLICY "agenda_tracks_select_anon"
  ON public.events_agenda_tracks FOR SELECT TO anon
  USING (EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.id = events_agenda_tracks.event_uuid
      AND e.status = 'published'
  ));

CREATE POLICY "agenda_tracks_select_auth"
  ON public.events_agenda_tracks FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.id = events_agenda_tracks.event_uuid
      AND e.status = 'published'
  ) OR public.can_admin_event(event_uuid));

CREATE POLICY "agenda_tracks_insert"
  ON public.events_agenda_tracks FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_event(event_uuid));

CREATE POLICY "agenda_tracks_update"
  ON public.events_agenda_tracks FOR UPDATE TO authenticated
  USING (public.can_admin_event(event_uuid));

CREATE POLICY "agenda_tracks_delete"
  ON public.events_agenda_tracks FOR DELETE TO authenticated
  USING (public.can_admin_event(event_uuid));

-- Agenda entries
CREATE POLICY "agenda_entries_select_anon"
  ON public.events_agenda_entries FOR SELECT TO anon
  USING (EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.id = events_agenda_entries.event_uuid
      AND e.status = 'published'
  ));

CREATE POLICY "agenda_entries_select_auth"
  ON public.events_agenda_entries FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.id = events_agenda_entries.event_uuid
      AND e.status = 'published'
  ) OR public.can_admin_event(event_uuid));

CREATE POLICY "agenda_entries_insert"
  ON public.events_agenda_entries FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_event(event_uuid));

CREATE POLICY "agenda_entries_update"
  ON public.events_agenda_entries FOR UPDATE TO authenticated
  USING (public.can_admin_event(event_uuid));

CREATE POLICY "agenda_entries_delete"
  ON public.events_agenda_entries FOR DELETE TO authenticated
  USING (public.can_admin_event(event_uuid));
