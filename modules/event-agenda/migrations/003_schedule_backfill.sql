-- Backfill of past events (spec-event-agenda-schedule-import §6.5).
--
-- The importer already owns one event at a time. The backfill is the operator
-- surface for running it over every past conference: a run row that holds the
-- cursor and the pause switch, and an item row per event so the operator can
-- review what the importer decided before letting it carry on.
--
-- The spec asks for two things the per-event tables cannot give:
--
--  * A pause. The worker re-enqueues itself after each batch and stops when
--    the run's state is no longer 'running', so pausing is one UPDATE and
--    there is no job to kill.
--  * A review trail. §6.5 warns that speaker mis-resolution is most likely
--    and least visible in a backfill, so each item records the speaker counts
--    the importer reported for that event. events_schedule_imports.stats only
--    keeps the latest import, which a long run overwrites.
--
-- Both tables are service-role write / admin read, like §4.1's.

CREATE TABLE IF NOT EXISTS public.events_schedule_backfill_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state text NOT NULL DEFAULT 'running'
    CHECK (state IN ('running', 'paused', 'complete', 'cancelled')),
  -- Why it is paused, so the admin can tell an operator pause from the
  -- automatic review gate. NULL whenever state <> 'paused'.
  pause_reason text
    CHECK (pause_reason IS NULL OR pause_reason IN ('operator', 'review')),
  -- auth.users id of whoever started it. No FK: auth is a different schema
  -- and a deleted user must not delete the audit trail.
  requested_by uuid,

  -- Events per job invocation. Each one is paced per §5.4, so this also sets
  -- how long a single job holds a worker slot.
  batch_size integer NOT NULL DEFAULT 5 CHECK (batch_size BETWEEN 1 AND 50),
  -- Pause for review after this many events. 0 disables the gate, which §6.5
  -- says to do only after the first few events have been reviewed by hand.
  review_every integer NOT NULL DEFAULT 5 CHECK (review_every BETWEEN 0 AND 10000),
  -- Re-attempt events a previous run recorded as 'unavailable'. Off by
  -- default: §6.5 treats a dead source as a normal outcome recorded once, not
  -- an error to retry.
  retry_unavailable boolean NOT NULL DEFAULT false,
  -- Re-import events that already imported successfully. Off by default.
  force_reimport boolean NOT NULL DEFAULT false,

  -- The cursor, as (event_start, id) so it is total and stable under ties.
  -- Oldest first, per §6.5.
  cursor_event_start timestamptz,
  cursor_event_uuid uuid,

  processed integer NOT NULL DEFAULT 0,
  -- Counts by importer outcome, plus 'errored' for an item the worker itself
  -- could not run.
  complete_count integer NOT NULL DEFAULT 0,
  unavailable_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  -- Events in scope when the run started, for a progress reading. A snapshot,
  -- not a guarantee: the scope query runs again each batch.
  scope_total integer,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

COMMENT ON TABLE public.events_schedule_backfill_runs IS
  'One row per backfill of past conference programmes: its cursor, its pause switch and its running totals.';
COMMENT ON COLUMN public.events_schedule_backfill_runs.review_every IS
  'Pause for operator review after this many events. 0 disables the gate (spec §6.5).';

-- Only one run may be live at a time. Two runs sharing a cursor would import
-- the same events twice and double every count.
--
-- The index expression is the constant `true`, not `state`. Indexing `state`
-- here would mean "at most one 'running' AND at most one 'paused'", which
-- permits exactly the pair this is meant to forbid. Verified by inserting a
-- running row and then a paused one: on `(state)` both succeed, on `(true)`
-- the second is rejected. A 'complete' or 'cancelled' row falls out of the
-- predicate and frees the slot.
CREATE UNIQUE INDEX IF NOT EXISTS events_schedule_backfill_runs_one_live
  ON public.events_schedule_backfill_runs ((true))
  WHERE state IN ('running', 'paused');

CREATE TABLE IF NOT EXISTS public.events_schedule_backfill_items (
  run_id uuid NOT NULL
    REFERENCES public.events_schedule_backfill_runs(id) ON DELETE CASCADE,
  event_uuid uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  -- The importer's own status, or 'errored' when the worker could not run it.
  status text NOT NULL
    CHECK (status IN ('complete', 'unavailable', 'failed', 'skipped', 'errored')),
  -- §6.5's review signal: how many speakers the importer resolved to real
  -- people on this event, and how many it left as placeholders. A sudden jump
  -- in matched is what a mis-resolution looks like.
  speakers integer,
  speakers_matched_people integer,
  unmatched_speakers integer,
  sessions integer,
  error text,
  -- Ordering key, copied so the review listing does not need to join events.
  event_start timestamptz,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, event_uuid)
);

COMMENT ON TABLE public.events_schedule_backfill_items IS
  'What a backfill run did to one event, kept for the operator review §6.5 asks for.';

CREATE INDEX IF NOT EXISTS events_schedule_backfill_items_run_order
  ON public.events_schedule_backfill_items (run_id, processed_at DESC);
-- The review listing filters to the outcomes worth looking at.
CREATE INDEX IF NOT EXISTS events_schedule_backfill_items_status
  ON public.events_schedule_backfill_items (run_id, status);

ALTER TABLE public.events_schedule_backfill_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_schedule_backfill_items ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- A backfill is global, not per-event, so is_admin() is the right predicate.
  -- can_admin_event would let an event organiser read every other event's
  -- import outcomes through the item rows.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'events_schedule_backfill_runs'
      AND policyname = 'events_schedule_backfill_runs_select'
  ) THEN
    CREATE POLICY "events_schedule_backfill_runs_select"
      ON public.events_schedule_backfill_runs FOR SELECT TO authenticated
      USING (public.is_admin());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'events_schedule_backfill_items'
      AND policyname = 'events_schedule_backfill_items_select'
  ) THEN
    CREATE POLICY "events_schedule_backfill_items_select"
      ON public.events_schedule_backfill_items FOR SELECT TO authenticated
      USING (public.is_admin());
  END IF;
END $$;

-- Writes are service-role only (the worker and the admin routes); no
-- INSERT/UPDATE/DELETE policies are granted to authenticated deliberately.
