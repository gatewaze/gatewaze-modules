-- spec-ai-mcp-extensions.md §Data Models §Per-use-case Goose runtime overrides.
--
-- Operators want to tune Goose knobs per workload: research recipes
-- need a higher GOOSE_TOOL_CALL_CUTOFF than a brief Q&A; an
-- approval-required chat needs GOOSE_MODE=approval; a reasoning-heavy
-- merger benefits from CLAUDE_THINKING_TYPE=enabled.
--
-- Storage: a jsonb map keyed by env-var name. Writes validated by
-- the trigger below against an EXPLICIT ALLOWLIST with per-key
-- range/enum validators. Out-of-allowlist keys and out-of-range
-- values are rejected at write time — never reach the worker.
--
-- Allowlist is duplicated between this trigger (defence-in-depth at
-- the DB layer) and packages/api/src/lib/queue/goose-overrides.ts
-- (the canonical TS source of truth, validated on API write). Both
-- must stay in sync; CI grep enforces.

ALTER TABLE public.ai_use_cases
  ADD COLUMN IF NOT EXISTS goose_runtime_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.validate_goose_runtime_overrides()
RETURNS trigger AS $$
DECLARE
  k text;
  v jsonb;
BEGIN
  IF NEW.goose_runtime_overrides IS NULL OR NEW.goose_runtime_overrides = '{}'::jsonb THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(NEW.goose_runtime_overrides) <> 'object' THEN
    RAISE EXCEPTION 'goose_runtime_overrides must be a JSON object'
      USING ERRCODE = 'check_violation';
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each(NEW.goose_runtime_overrides) LOOP
    CASE k
      WHEN 'GOOSE_AUTO_COMPACT_THRESHOLD' THEN
        IF NOT (jsonb_typeof(v) = 'number' AND (v#>>'{}')::numeric BETWEEN 0.1 AND 0.99) THEN
          RAISE EXCEPTION 'GOOSE_AUTO_COMPACT_THRESHOLD must be a number in [0.1, 0.99]; got %', v
            USING ERRCODE = 'check_violation';
        END IF;
      WHEN 'GOOSE_TOOL_CALL_CUTOFF' THEN
        IF NOT (jsonb_typeof(v) = 'number' AND (v#>>'{}')::integer BETWEEN 100 AND 1000000) THEN
          RAISE EXCEPTION 'GOOSE_TOOL_CALL_CUTOFF must be an integer in [100, 1000000]; got %', v
            USING ERRCODE = 'check_violation';
        END IF;
      WHEN 'GOOSE_MODE' THEN
        IF NOT (jsonb_typeof(v) = 'string' AND (v#>>'{}') IN ('auto', 'approval', 'chat')) THEN
          RAISE EXCEPTION 'GOOSE_MODE must be one of auto|approval|chat; got %', v
            USING ERRCODE = 'check_violation';
        END IF;
      WHEN 'CLAUDE_THINKING_TYPE' THEN
        IF NOT (jsonb_typeof(v) = 'string' AND (v#>>'{}') IN ('disabled', 'enabled')) THEN
          RAISE EXCEPTION 'CLAUDE_THINKING_TYPE must be disabled|enabled; got %', v
            USING ERRCODE = 'check_violation';
        END IF;
      WHEN 'GATEWAZE_GOOSE_MAX_TURNS' THEN
        IF NOT (jsonb_typeof(v) = 'number' AND (v#>>'{}')::integer BETWEEN 1 AND 5000) THEN
          RAISE EXCEPTION 'GATEWAZE_GOOSE_MAX_TURNS must be an integer in [1, 5000]; got %', v
            USING ERRCODE = 'check_violation';
        END IF;
      WHEN 'GATEWAZE_GOOSE_MAX_TOOL_REPETITIONS' THEN
        IF NOT (jsonb_typeof(v) = 'number' AND (v#>>'{}')::integer BETWEEN 1 AND 10000) THEN
          RAISE EXCEPTION 'GATEWAZE_GOOSE_MAX_TOOL_REPETITIONS must be an integer in [1, 10000]; got %', v
            USING ERRCODE = 'check_violation';
        END IF;
      WHEN 'GATEWAZE_MEMORY_DEFAULT_TTL_SECONDS' THEN
        IF NOT (jsonb_typeof(v) = 'number' AND (v#>>'{}')::integer BETWEEN 0 AND 31536000) THEN
          RAISE EXCEPTION 'GATEWAZE_MEMORY_DEFAULT_TTL_SECONDS must be an integer in [0, 31536000]; got %', v
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        RAISE EXCEPTION 'goose_runtime_overrides key % is not allowlisted', k
          USING ERRCODE = 'check_violation';
    END CASE;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_use_cases_validate_goose_overrides ON public.ai_use_cases;
CREATE TRIGGER ai_use_cases_validate_goose_overrides
  BEFORE INSERT OR UPDATE OF goose_runtime_overrides ON public.ai_use_cases
  FOR EACH ROW EXECUTE FUNCTION public.validate_goose_runtime_overrides();

COMMENT ON COLUMN public.ai_use_cases.goose_runtime_overrides IS
  'jsonb map of allowlisted env-var-name → value, applied per-spawn on top of worker env. Validated by validate_goose_runtime_overrides trigger. See spec-ai-mcp-extensions.md for the canonical allowlist + range tables.';
