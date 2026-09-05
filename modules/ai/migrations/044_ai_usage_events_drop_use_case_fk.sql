-- ai module — 044: usage history must outlive its use case.
--
-- spec-ai-subscription-tokens.md §5: deleting a use case RETAINS its
-- ai_usage_events rows as free-standing audit/cost history keyed by the id
-- string. The ON DELETE RESTRICT foreign key contradicted that — deletion
-- failed for any use case that had ever been invoked (i.e. exactly the ones
-- an operator wants to kill). Inserts still only happen for registered use
-- cases (runChat refuses unregistered ids before any usage row is written),
-- so the constraint bought nothing but the bug.

alter table public.ai_usage_events
  drop constraint if exists ai_usage_events_use_case_fkey;
