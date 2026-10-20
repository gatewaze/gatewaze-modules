-- ============================================================================
-- 092_editions_research_time
-- ============================================================================
-- An edition knows when it should go out (send_target_at) and when its
-- research blocks should run (research_at). research_at is NULLABLE: null
-- means "derived" (send_target_at minus the collection's research_lead_hours,
-- default 36), so moving the send target moves the research time with it; a
-- value pins it. One SQL function is the single source of the effective time
-- for the cron, the UI and the gate. spec-content-discovery-and-research-
-- blocks.md §5.3. Executed in the spec's .layer4.sql run. Idempotent.
-- ============================================================================
ALTER TABLE public.newsletters_editions
  ADD COLUMN IF NOT EXISTS send_target_at timestamptz,
  ADD COLUMN IF NOT EXISTS research_at timestamptz;

COMMENT ON COLUMN public.newsletters_editions.send_target_at IS
  'When this edition is meant to go out. Distinct from newsletter_sends.scheduled_at, which only exists once a send is set up.';
COMMENT ON COLUMN public.newsletters_editions.research_at IS
  'Pinned research time. NULL = derived from send_target_at minus the collection cadence research_lead_hours (default 36). See newsletters_effective_research_at().';

-- The collection-level cadence settings live in one jsonb (part 3 adds the
-- occurrence maths; research_lead_hours is read from it here already).
ALTER TABLE public.newsletters_template_collections
  ADD COLUMN IF NOT EXISTS cadence jsonb;
COMMENT ON COLUMN public.newsletters_template_collections.cadence IS
  '{enabled, freq, byweekday|bymonthday|bynthweekday, hour, minute, timezone, create_lead_days, research_lead_hours, title_pattern}. See spec §6.';

CREATE OR REPLACE FUNCTION public.newsletters_effective_research_at(p_edition_id uuid)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  -- The cadence jsonb is operator-written; a non-numeric or absurd value must
  -- not make this function throw (which would silently disable research for
  -- the whole collection), so it falls back to 36 and is clamped to 1..336.
  SELECT coalesce(e.research_at,
                  e.send_target_at - make_interval(hours =>
                    least(336, greatest(1, coalesce(
                      nullif(regexp_replace(coalesce(c.cadence->>'research_lead_hours', ''), '[^0-9]', '', 'g'), '')::int, 36)))))
  FROM public.newsletters_editions e
  LEFT JOIN public.newsletters_template_collections c ON c.id = e.collection_id
  WHERE e.id = p_edition_id;
$$;
REVOKE ALL ON FUNCTION public.newsletters_effective_research_at(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.newsletters_effective_research_at(uuid) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_newsletters_editions_send_target
  ON public.newsletters_editions (collection_id, send_target_at)
  WHERE send_target_at IS NOT NULL;
