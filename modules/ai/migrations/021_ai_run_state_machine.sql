-- spec-ai-job-runner §6.3 — enforce status-transition state machine on
-- ai_recipe_runs + ai_messages via BEFORE UPDATE trigger.
--
-- The CHECK constraints in migrations 017/018 validate the SET of
-- allowed values; this trigger validates the EDGES between them.
--
-- ai_recipe_runs allowed transitions:
--   queued     → running | cancelled | cancelling
--   running    → complete | failed | cancelled | cancelling | budget_blocked
--   cancelling → cancelled
--   (terminal: complete | failed | cancelled | budget_blocked — no transitions out)
--
-- ai_messages allowed transitions:
--   pending    → queued | running | failed | cancelled
--   queued     → running | cancelled | cancelling
--   running    → complete | failed | cancelled | cancelling
--   cancelling → cancelled
--   (terminal: complete | failed | cancelled)
--
-- Same-state UPDATEs (e.g. UPDATE … SET status = 'running' WHERE
-- status = 'running') are allowed — they're idempotent.

CREATE OR REPLACE FUNCTION public.enforce_ai_recipe_runs_state_machine()
RETURNS trigger AS $$
DECLARE
  ok boolean := false;
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  ok := CASE OLD.status
    WHEN 'queued' THEN NEW.status IN ('running','cancelled','cancelling')
    WHEN 'running' THEN NEW.status IN ('complete','failed','cancelled','cancelling','budget_blocked')
    WHEN 'cancelling' THEN NEW.status IN ('cancelled')
    ELSE false  -- terminal states
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'invalid ai_recipe_runs status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_recipe_runs_state_machine_check ON public.ai_recipe_runs;
CREATE TRIGGER ai_recipe_runs_state_machine_check
  BEFORE UPDATE OF status ON public.ai_recipe_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_ai_recipe_runs_state_machine();

CREATE OR REPLACE FUNCTION public.enforce_ai_messages_state_machine()
RETURNS trigger AS $$
DECLARE
  ok boolean := false;
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  ok := CASE OLD.status
    WHEN 'pending' THEN NEW.status IN ('queued','running','failed','cancelled')
    WHEN 'queued' THEN NEW.status IN ('running','cancelled','cancelling')
    WHEN 'running' THEN NEW.status IN ('complete','failed','cancelled','cancelling')
    WHEN 'cancelling' THEN NEW.status IN ('cancelled')
    ELSE false
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'invalid ai_messages status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_messages_state_machine_check ON public.ai_messages;
CREATE TRIGGER ai_messages_state_machine_check
  BEFORE UPDATE OF status ON public.ai_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_ai_messages_state_machine();
