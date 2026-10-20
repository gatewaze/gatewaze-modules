-- ============================================================================
-- 093_research_runs
-- ============================================================================
-- One row per research run of one block of one edition. The research layer
-- of a block is always the output of its latest completed run; author edits
-- live in content.research_edits and are merged at read time (spec §5.2).
--
--   * seq is the order of runs: created_at ties inside a transaction (found
--     by executing the spec's SQL), so "newer run wins" is on seq.
--   * one in-flight run per block: the due cron inserts the row itself and
--     the partial unique index refuses a second (two ticks under backlog
--     cannot double the AI spend).
--   * a state trigger makes terminal states terminal.
--   * newsletters_research_write() is the ONLY write path for the research
--     layer: one field by jsonb_set, open editions only (see
--     newsletters_edition_research_open), refused when a newer run has
--     already completed, and it BUMPS the edition version so an editor
--     holding a stale copy gets version_conflict instead of writing the old
--     list back. Service role only.
--   * "Open" is a draft OR a published edition that has not started going
--     out. Sending requires published, so research due before a scheduled
--     send must still land on the published edition; once any send of the
--     edition is sending/sent/paused/cancelling, or has sent to anyone, the
--     content is what went out and research stops.
-- Executed in the spec's .layer4.sql run. Idempotent.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.newsletters_research_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  edition_id      uuid NOT NULL REFERENCES public.newsletters_editions(id) ON DELETE CASCADE,
  block_id        uuid NOT NULL REFERENCES public.newsletters_edition_blocks(id) ON DELETE CASCADE,
  block_def_id    uuid NOT NULL REFERENCES public.templates_block_defs(id),
  binding         jsonb NOT NULL,            -- data_source snapshot at run time
  binding_hash    text NOT NULL,             -- sha1 of binding; the edit layer records the hash it was made against
  triggered_by    text NOT NULL CHECK (triggered_by IN ('schedule','manual','daily','revert')),
  scheduled_for   timestamptz,               -- the research time this run satisfies (schedule runs)
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','complete','failed','cancelled')),
  failure_kind    text CHECK (failure_kind IN ('cost_cap','recipe','input','stale','output_invalid','other')),
  input_summary   jsonb,                     -- counts, window, source ids; not the payload
  output          jsonb,                     -- the value written to output.field
  ai_thread_id    uuid,                      -- ai_threads.id; no FK, newsletters does not depend on the ai module's schema
  cost_micro_usd  bigint NOT NULL DEFAULT 0,
  error           text,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- An earlier draft of this migration had an FK to ai_threads; drop it where it ran.
ALTER TABLE public.newsletters_research_runs DROP CONSTRAINT IF EXISTS newsletters_research_runs_ai_thread_id_fkey;
CREATE INDEX IF NOT EXISTS idx_newsletters_research_runs_block ON public.newsletters_research_runs (edition_id, block_id, seq DESC);
CREATE UNIQUE INDEX IF NOT EXISTS newsletters_research_runs_one_inflight
  ON public.newsletters_research_runs (block_id) WHERE status IN ('queued','running');

CREATE OR REPLACE FUNCTION public.newsletters_research_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF OLD.status IN ('complete','failed','cancelled') THEN
    RAISE EXCEPTION 'INVALID_STATE_TRANSITION % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'queued'  AND NEW.status NOT IN ('running','cancelled') THEN RAISE EXCEPTION 'INVALID_STATE_TRANSITION queued -> %', NEW.status; END IF;
  IF OLD.status = 'running' AND NEW.status NOT IN ('complete','failed','cancelled') THEN RAISE EXCEPTION 'INVALID_STATE_TRANSITION running -> %', NEW.status; END IF;
  IF NEW.status IN ('complete','failed','cancelled') THEN NEW.completed_at := coalesce(NEW.completed_at, now()); END IF;
  IF NEW.status = 'running' THEN NEW.started_at := coalesce(NEW.started_at, now()); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS newsletters_research_runs_guard ON public.newsletters_research_runs;
CREATE TRIGGER newsletters_research_runs_guard BEFORE UPDATE ON public.newsletters_research_runs
  FOR EACH ROW EXECUTE FUNCTION public.newsletters_research_runs_guard();

-- Admins READ runs; every write goes through the service role (worker and
-- admin routes). A forged `complete` row with arbitrary output would satisfy
-- the send gate and feed the revert route, so no direct writes.
ALTER TABLE public.newsletters_research_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS research_runs_admin ON public.newsletters_research_runs;
DROP POLICY IF EXISTS research_runs_admin_select ON public.newsletters_research_runs;
CREATE POLICY research_runs_admin_select ON public.newsletters_research_runs
  FOR SELECT TO authenticated USING (public.is_admin());
REVOKE ALL ON public.newsletters_research_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.newsletters_research_runs TO authenticated;
GRANT ALL ON public.newsletters_research_runs TO service_role;

-- Whether research may still change an edition (runs and the edit layer).
-- Service role only: it would otherwise tell any signed-in user whether an
-- edition has gone out. The two SECURITY DEFINER writers below call it as
-- the owner.
CREATE OR REPLACE FUNCTION public.newsletters_edition_research_open(p_edition_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((
    SELECT e.status IN ('draft','published')
       AND NOT EXISTS (
         SELECT 1 FROM public.newsletter_sends s
          WHERE s.edition_id = e.id
            AND (s.status IN ('sending','sent','paused','cancelling') OR coalesce(s.sent_count, 0) > 0))
      FROM public.newsletters_editions e WHERE e.id = p_edition_id), false);
$$;
REVOKE ALL ON FUNCTION public.newsletters_edition_research_open(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.newsletters_edition_research_open(uuid) TO service_role;

-- The research layer write.
CREATE OR REPLACE FUNCTION public.newsletters_research_write(p_block_id uuid, p_field text, p_value jsonb, p_run_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_edition uuid; v_status text; v_version int; v_run_seq bigint;
BEGIN
  IF p_field !~ '^[a-z][a-z0-9_]{0,63}$' THEN RAISE EXCEPTION 'INVALID_FIELD %', p_field; END IF;
  SELECT b.edition_id, e.status, e.version INTO v_edition, v_status, v_version
  FROM public.newsletters_edition_blocks b JOIN public.newsletters_editions e ON e.id = b.edition_id
  WHERE b.id = p_block_id AND b.deleted_at IS NULL FOR UPDATE OF e;
  IF v_edition IS NULL THEN RAISE EXCEPTION 'BLOCK_NOT_FOUND'; END IF;
  IF NOT public.newsletters_edition_research_open(v_edition) THEN RAISE EXCEPTION 'EDITION_NOT_OPEN %', v_status; END IF;
  -- Only a RUNNING run may write: a run cancelled or swept while the worker
  -- was still going must not land its output.
  SELECT seq INTO v_run_seq FROM public.newsletters_research_runs
   WHERE id = p_run_id AND block_id = p_block_id AND status = 'running' FOR UPDATE;
  IF v_run_seq IS NULL THEN RAISE EXCEPTION 'RUN_NOT_RUNNING'; END IF;
  IF EXISTS (SELECT 1 FROM public.newsletters_research_runs
             WHERE block_id = p_block_id AND status = 'complete' AND seq > v_run_seq) THEN
    RAISE EXCEPTION 'SUPERSEDED_BY_NEWER_RUN';
  END IF;
  UPDATE public.newsletters_edition_blocks
     SET content = jsonb_set(coalesce(content, '{}'::jsonb), ARRAY[p_field], p_value, true), updated_at = now()
   WHERE id = p_block_id;
  UPDATE public.newsletters_editions SET version = coalesce(version, 0) + 1, updated_at = now() WHERE id = v_edition
  RETURNING version INTO v_version;
  RETURN v_version;
END $$;
REVOKE ALL ON FUNCTION public.newsletters_research_write(uuid, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.newsletters_research_write(uuid, text, jsonb, uuid) TO service_role;

-- Editor-side write of the edit layer only (one field, version bump, admin
-- caller). Lets the editor save a pin/override without a whole-content
-- save, so a research run landing mid-edit cannot be clobbered either way.
CREATE OR REPLACE FUNCTION public.newsletters_research_edits_write(p_block_id uuid, p_edits jsonb, p_expected_version integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_edition uuid; v_status text; v_version int;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT b.edition_id, e.status, e.version INTO v_edition, v_status, v_version
  FROM public.newsletters_edition_blocks b JOIN public.newsletters_editions e ON e.id = b.edition_id
  WHERE b.id = p_block_id AND b.deleted_at IS NULL FOR UPDATE OF e;
  IF v_edition IS NULL THEN RAISE EXCEPTION 'BLOCK_NOT_FOUND'; END IF;
  IF NOT public.newsletters_edition_research_open(v_edition) THEN RAISE EXCEPTION 'EDITION_NOT_OPEN %', v_status; END IF;
  IF p_expected_version IS NULL THEN RAISE EXCEPTION 'VERSION_REQUIRED'; END IF;
  IF v_version <> p_expected_version THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = '55006';
  END IF;
  IF p_edits IS NOT NULL AND jsonb_typeof(p_edits) <> 'object' THEN RAISE EXCEPTION 'EDITS_MUST_BE_OBJECT'; END IF;
  IF pg_column_size(p_edits) > 262144 THEN RAISE EXCEPTION 'EDITS_TOO_LARGE'; END IF;
  UPDATE public.newsletters_edition_blocks
     SET content = jsonb_set(coalesce(content, '{}'::jsonb), ARRAY['research_edits'], coalesce(p_edits, '{}'::jsonb), true), updated_at = now()
   WHERE id = p_block_id;
  UPDATE public.newsletters_editions SET version = coalesce(version, 0) + 1, updated_at = now() WHERE id = v_edition
  RETURNING version INTO v_version;
  RETURN v_version;
END $$;
REVOKE ALL ON FUNCTION public.newsletters_research_edits_write(uuid, jsonb, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.newsletters_research_edits_write(uuid, jsonb, integer) TO authenticated, service_role;
