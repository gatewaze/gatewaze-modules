-- Schedule import (spec-event-agenda-schedule-import §4.1, §4.2, §6.3).
--
-- Two tables: one row per event holding the import's state machine, and a
-- provenance table that makes re-import idempotent without putting an
-- import_ref column on four other modules' tables.
--
-- Both are service-role write / admin read: the importer runs as the worker,
-- and the Agenda tab reads status. Nothing is exposed to anon.

CREATE TABLE IF NOT EXISTS public.events_schedule_imports (
  event_uuid uuid PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
  -- Registry key (§5.5). The enum grows as parsers are added.
  source_kind text NOT NULL DEFAULT 'sched'
    CHECK (source_kind IN ('sched')),
  -- The page an operator or scraper gave us (an LF event page, or a sched host).
  schedule_url text,
  -- What the parser actually reads, after detection (e.g. https://<host>.sched.com).
  resolved_source_url text,
  url_origin text NOT NULL DEFAULT 'event'
    CHECK (url_origin IN ('event', 'manual')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'unavailable', 'importing', 'complete', 'failed')),
  -- sha256 over the fetched bytes; unchanged means skip the write pass.
  content_hash text,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  error text,
  -- {sessions, breaks, tracks, speakers, speakers_matched_people,
  --  unmatched_speakers, stale[], preserved_edits, skeleton_mismatch, unchanged}
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.events_schedule_imports IS
  'One row per event: where its programme comes from and the state of the last import.';
COMMENT ON COLUMN public.events_schedule_imports.status IS
  'unavailable = the page resolved but publishes no programme yet; the sweep retries it.';

CREATE TABLE IF NOT EXISTS public.events_schedule_import_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_uuid uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  source_kind text NOT NULL,
  -- Stable id on the source: a sched event UID, a sched speaker id, a track name.
  source_ref text NOT NULL,
  entity_type text NOT NULL
    CHECK (entity_type IN ('agenda_entry', 'track', 'talk', 'speaker_profile')),
  -- The row we created or adopted. No FK: four different target tables.
  entity_id uuid NOT NULL,
  -- Hash of the source-owned fields the importer last wrote (§6.3). A field
  -- whose current value still equals this is safe to update; one that differs
  -- was edited by a human and is left alone.
  source_fingerprint text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_uuid, source_kind, source_ref, entity_type)
);

CREATE INDEX IF NOT EXISTS events_schedule_import_refs_entity
  ON public.events_schedule_import_refs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS events_schedule_import_refs_event
  ON public.events_schedule_import_refs (event_uuid);

ALTER TABLE public.events_schedule_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_schedule_import_refs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'events_schedule_imports'
      AND policyname = 'events_schedule_imports_select'
  ) THEN
    CREATE POLICY "events_schedule_imports_select"
      ON public.events_schedule_imports FOR SELECT TO authenticated
      USING (public.can_admin_event(event_uuid) OR public.is_admin());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'events_schedule_import_refs'
      AND policyname = 'events_schedule_import_refs_select'
  ) THEN
    CREATE POLICY "events_schedule_import_refs_select"
      ON public.events_schedule_import_refs FOR SELECT TO authenticated
      USING (public.can_admin_event(event_uuid) OR public.is_admin());
  END IF;
END $$;

-- Writes are service-role only (the importer); no INSERT/UPDATE/DELETE
-- policies are granted to authenticated deliberately.
