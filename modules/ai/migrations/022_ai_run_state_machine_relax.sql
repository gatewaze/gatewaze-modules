-- spec-ai-job-runner — relax 021's state-machine triggers.
--
-- 021's transition map was too strict in two specific cases:
--
--   1. A worker that hits an unrecoverable error BEFORE marking the
--      row 'running' (e.g. snapshot missing, dependency resolution
--      failure) needs to transition the row to 'failed' directly.
--      Without this allowance, the supabase-js update() returns a
--      check_violation that the handler may swallow silently, leaving
--      the row stuck at 'queued' forever.
--
--   2. Same for terminal admin actions: forcibly marking a queued
--      run as 'complete' (e.g. operator-driven manual completion) or
--      'cancelled' (cancel-before-pickup, which the worker SHOULD
--      handle as an early-exit but might race).
--
-- We keep the spirit of 021 — running -> {complete,failed,cancelled}
-- is still the canonical path — but allow direct queued -> terminal
-- jumps so an unhealthy worker can never wedge a row.

CREATE OR REPLACE FUNCTION public.enforce_ai_recipe_runs_state_machine()
RETURNS trigger AS $$
DECLARE
  ok boolean := false;
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  ok := CASE OLD.status
    -- queued can go anywhere except back to queued (already filtered above).
    WHEN 'queued' THEN NEW.status IN ('running','complete','failed','cancelled','cancelling','budget_blocked')
    WHEN 'running' THEN NEW.status IN ('complete','failed','cancelled','cancelling','budget_blocked')
    WHEN 'cancelling' THEN NEW.status IN ('cancelled','failed')
    ELSE false  -- terminal states (complete | failed | cancelled | budget_blocked)
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'invalid ai_recipe_runs status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.enforce_ai_messages_state_machine()
RETURNS trigger AS $$
DECLARE
  ok boolean := false;
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  ok := CASE OLD.status
    WHEN 'pending' THEN NEW.status IN ('queued','running','complete','failed','cancelled')
    WHEN 'queued' THEN NEW.status IN ('running','complete','failed','cancelled','cancelling')
    WHEN 'running' THEN NEW.status IN ('complete','failed','cancelled','cancelling')
    WHEN 'cancelling' THEN NEW.status IN ('cancelled','failed')
    ELSE false
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'invalid ai_messages status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
