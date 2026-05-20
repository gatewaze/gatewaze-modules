-- spec-ai-mcp-extensions.md open question #4 — per-MCP rate limiting.
--
-- Extends validate_goose_runtime_overrides to allow two new keys:
--   MCP_MAX_TOOL_CALLS_PER_HOUR       use-case-wide cap (every allowlisted server)
--   MCP_MAX_TOOL_CALLS_PER_HOUR_<NAME> per-server override (caller substitutes
--                                       UPPER_SNAKE_CASE server name)
--
-- Both are positive integers; the resolvers compare the trailing-hour
-- count of ai_usage_events(kind='mcp_tool', provider=<server>) against
-- the effective cap and exclude over-budget servers from the spawn.

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
    -- Per-server rate-limit override matches MCP_MAX_TOOL_CALLS_PER_HOUR_<NAME>.
    -- Server names canonicalised UPPER_SNAKE_CASE (matches the resolver's
    -- key derivation in lib/mcp/rate-limit.ts).
    IF k ~ '^MCP_MAX_TOOL_CALLS_PER_HOUR_[A-Z][A-Z0-9_]*$' THEN
      IF NOT (jsonb_typeof(v) = 'number' AND (v#>>'{}')::integer BETWEEN 1 AND 1000000) THEN
        RAISE EXCEPTION '% must be an integer in [1, 1000000]; got %', k, v
          USING ERRCODE = 'check_violation';
      END IF;
      CONTINUE;
    END IF;
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
      WHEN 'MCP_MAX_TOOL_CALLS_PER_HOUR' THEN
        IF NOT (jsonb_typeof(v) = 'number' AND (v#>>'{}')::integer BETWEEN 1 AND 1000000) THEN
          RAISE EXCEPTION 'MCP_MAX_TOOL_CALLS_PER_HOUR must be an integer in [1, 1000000]; got %', v
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
