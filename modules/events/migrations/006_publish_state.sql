-- ============================================================================
-- events module — publish_state column + state machine integration
-- The state machine + audit + queue + central setter all live in
-- content-platform. This migration adds the events.publish_state column,
-- backfills it, makes is_live_in_production a generated column, and rewires
-- the existing triage adapter functions through the platform RPC.
-- ============================================================================

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS publish_state text NOT NULL DEFAULT 'published'
  CHECK (publish_state IN
    ('draft','pending_review','auto_suppressed','rejected','published','unpublished'));

DO $backfill$
DECLARE
  v_batch_size constant int := 5000;
  v_updated int;
  v_total int := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id FROM public.events
       WHERE publish_state = 'published'
         AND (is_live_in_production = false
              OR status IN ('rejected','pending_review'))
       LIMIT v_batch_size
       FOR UPDATE SKIP LOCKED
    )
    UPDATE public.events e
       SET publish_state = CASE
             WHEN e.is_live_in_production = false THEN 'unpublished'
             WHEN e.status = 'rejected'           THEN 'rejected'
             WHEN e.status = 'pending_review'     THEN 'pending_review'
             ELSE 'published'
           END
      FROM batch
     WHERE e.id = batch.id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    v_total := v_total + v_updated;
    EXIT WHEN v_updated = 0;
    RAISE NOTICE '[events/006_publish_state] backfilled % rows (total: %)', v_updated, v_total;
    PERFORM pg_sleep(0.05);
  END LOOP;
  RAISE NOTICE '[events/006_publish_state] backfill complete: % rows', v_total;
END $backfill$;

ALTER TABLE public.events ALTER COLUMN is_live_in_production DROP DEFAULT;
ALTER TABLE public.events DROP COLUMN is_live_in_production;
ALTER TABLE public.events
  ADD COLUMN is_live_in_production boolean
  GENERATED ALWAYS AS (publish_state = 'published') STORED;

CREATE INDEX IF NOT EXISTS events_publish_state_live
  ON public.events(publish_state) WHERE publish_state = 'published';

-- The triage_reject path writes rejection_reason. The 004_triage_adapter
-- migration is supposed to add it, but it's gated on content-triage being
-- installed — ensure it exists here so SECURITY DEFINER fns don't 42703.
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS rejection_reason text;

-- Grant the platform's SECURITY DEFINER setter (owned by gatewaze_module_writer)
-- the columns it needs to UPDATE. Without this, content_publish_state_set
-- raises 42501 on every state transition.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    GRANT UPDATE (publish_state, rejection_reason, content_category)
      ON public.events
      TO gatewaze_module_writer;
  END IF;
END $grants$;

-- ----------------------------------------------------------------------------
-- Backwards-compat wrapper. Existing call sites (eventService, scraper handler)
-- continue to work; new code can call the platform RPC directly.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.events_publish_state_set(
  p_id uuid, p_to text, p_actor text, p_reason text
) RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT public.content_publish_state_set('event', p_id, p_to, p_actor, p_reason);
$$;
ALTER FUNCTION public.events_publish_state_set(uuid, text, text, text)
  OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.events_publish_state_set(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.events_publish_state_set(uuid, text, text, text) TO service_role;

-- ----------------------------------------------------------------------------
-- Triage adapter functions — call the platform RPC under the hood.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.events_triage_approve(
  p_content_id uuid, p_categories text[], p_featured boolean, p_reviewer uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE v_actor text;
BEGIN
  v_actor := COALESCE('admin:' || p_reviewer::text, 'system:auto_approve');
  PERFORM public.content_publish_state_set('event', p_content_id, 'published', v_actor, 'triage_approve');
  IF p_categories IS NOT NULL AND array_length(p_categories, 1) > 0 THEN
    UPDATE public.events
       SET content_category = COALESCE(p_categories[1], content_category)
     WHERE id = p_content_id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.events_triage_reject(
  p_content_id uuid, p_reason text, p_reviewer uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE v_actor text;
BEGIN
  v_actor := COALESCE('admin:' || p_reviewer::text, 'system:reject');
  PERFORM public.content_publish_state_set('event', p_content_id, 'rejected', v_actor, p_reason);
  UPDATE public.events SET rejection_reason = p_reason WHERE id = p_content_id;
END $$;

CREATE OR REPLACE FUNCTION public.events_triage_submit(
  p_content_id uuid, p_reopen boolean
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE v_state text;
BEGIN
  SELECT publish_state INTO v_state FROM public.events WHERE id = p_content_id FOR UPDATE;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'Event % not found', p_content_id USING ERRCODE='P0002';
  END IF;
  IF p_reopen AND v_state = 'published' THEN
    PERFORM public.content_publish_state_set('event', p_content_id, 'pending_review',
      'system:triage_reopen', NULL);
  ELSIF NOT p_reopen AND v_state NOT IN ('pending_review','rejected','auto_suppressed') THEN
    PERFORM public.content_publish_state_set('event', p_content_id, 'pending_review',
      'system:triage_submit', NULL);
  END IF;
END $$;

COMMENT ON COLUMN public.events.status IS
  'DEPRECATED — superseded by publish_state. To be dropped in next release.';
COMMENT ON COLUMN public.events.is_live_in_production IS
  'DEPRECATED — generated column, computed from publish_state. To be dropped in next release.';
