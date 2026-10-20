-- ============================================================================
-- 094_send_gate
-- ============================================================================
-- An edition with research blocks must not go out while a run is still in
-- flight, before any run has completed, or after a run failed on a cost cap
-- (a human decision). One function, used twice: a BEFORE INSERT trigger on
-- newsletter_sends is the enforcement (the Sending tab inserts rows
-- directly, so there is no route to gate), and the Sending tab calls the
-- same function first to show the reason in words. spec §5.3. Idempotent.
-- ============================================================================
-- SECURITY DEFINER: evaluated as the caller, a caller who cannot read
-- templates_block_defs under RLS would see no research blocks and the gate
-- would fail OPEN. Read-only.
CREATE OR REPLACE FUNCTION public.newsletters_send_gate(p_edition_id uuid)
RETURNS TABLE (allowed boolean, reason_code text, block_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b record; r record;
BEGIN
  FOR b IN
    SELECT eb.id, d.data_source
    FROM public.newsletters_edition_blocks eb
    JOIN public.templates_block_defs d ON d.id = eb.templates_block_def_id
    WHERE eb.edition_id = p_edition_id AND eb.deleted_at IS NULL
      AND d.source_kind = 'research' AND coalesce(d.data_source->>'schedule','edition') = 'edition'
  LOOP
    SELECT * INTO r FROM public.newsletters_research_runs rr WHERE rr.block_id = b.id ORDER BY rr.seq DESC LIMIT 1;
    IF r.id IS NULL THEN RETURN QUERY SELECT false, 'NO_RESEARCH_RUN', b.id; RETURN; END IF;
    IF r.status IN ('queued','running') THEN RETURN QUERY SELECT false, 'RESEARCH_IN_PROGRESS', b.id; RETURN; END IF;
    IF r.status = 'failed' AND r.failure_kind = 'cost_cap' THEN RETURN QUERY SELECT false, 'COST_CAP_BREACH', b.id; RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.newsletters_research_runs rr WHERE rr.block_id = b.id AND rr.status = 'complete') THEN
      RETURN QUERY SELECT false, 'NO_RESEARCH_RUN', b.id; RETURN;
    END IF;
  END LOOP;
  RETURN QUERY SELECT true, 'OK', NULL::uuid;
END $$;
GRANT EXECUTE ON FUNCTION public.newsletters_send_gate(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.newsletter_sends_research_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE g record;
BEGIN
  -- On UPDATE only re-check when the row is re-pointed or moves into a
  -- dispatchable state; the dispatcher's own status flips (sending → sent)
  -- are left alone.
  IF TG_OP = 'UPDATE' AND NEW.edition_id = OLD.edition_id
     AND NOT (NEW.status IN ('scheduled','sending','queued') AND NEW.status <> OLD.status) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO g FROM public.newsletters_send_gate(NEW.edition_id);
  IF NOT g.allowed THEN
    RAISE EXCEPTION 'SEND_GATE:%:%', g.reason_code, g.block_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS newsletter_sends_research_gate ON public.newsletter_sends;
CREATE TRIGGER newsletter_sends_research_gate BEFORE INSERT OR UPDATE OF edition_id, status ON public.newsletter_sends
  FOR EACH ROW EXECUTE FUNCTION public.newsletter_sends_research_gate();
