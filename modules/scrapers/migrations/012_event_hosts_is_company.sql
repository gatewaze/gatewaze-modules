-- event_hosts can be either individuals (people we want to reach out to) or
-- companies / communities (the org itself is listed as a host, e.g. "n8n",
-- "AI Makerspace", "HUMAN+TECH WEEK"). We only want to run outreach on
-- individuals, so add an is_company flag + detection backfill.
--
-- Detection is heuristic (rules that match clear cases) — the Enricher and
-- admin UI can override when they find definitive signal (LinkedIn profile
-- URL, sentence-style bio mentioning first-person "we/our", etc.).

ALTER TABLE public.event_hosts
  ADD COLUMN IF NOT EXISTS is_company BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS event_hosts_is_company_idx
  ON public.event_hosts (is_company);

-- Backfill: mark rows as company based on a rule stack. Only sets TRUE —
-- doesn't flip back to FALSE on re-run, so admin overrides persist.
UPDATE public.event_hosts
SET is_company = TRUE
WHERE is_company = FALSE AND (
  -- Corporate suffix in the name
  name ~* '\m(Inc\.?|LLC|Ltd\.?|Corp\.?|GmbH|S\.?A\.?|SAS|PLC|Pty|Pvt|Foundation|Labs?|Studios?|Agency|Society|Group|Network|Community|Coalition|Institute|Consortium|Federation|Council|League|Alliance)\M'
  -- ALL CAPS multi-word names (e.g. "HUMAN+TECH WEEK") — people don't write their names that way
  OR (name ~ '^[A-Z0-9 +\-&\.]+$' AND length(name) > 4 AND name ~ ' ')
  -- (Previous rule "lowercase single token" was too noisy — caught nicknames
  --  like "kyle", "beata". Removed. Admin can manually mark edge cases.)
  -- bio starts with "We are" / "We're" / "our community" — classic org voice
  OR bio ~* '^\s*(we''re|we are|our community|our mission)'
);

-- Extend the admin listing RPC with an include_companies flag so the
-- dashboard can default to hiding company rows (the target for outreach
-- is individuals). Older callers without the arg get include_companies=false.
CREATE OR REPLACE FUNCTION public.event_hosts_with_event_count(
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit int DEFAULT 100,
  p_offset int DEFAULT 0,
  p_include_companies boolean DEFAULT false
)
RETURNS TABLE (
  id uuid,
  name text,
  email text,
  avatar_url text,
  luma_user_id text,
  luma_profile_url text,
  bio text,
  company text,
  job_title text,
  linkedin_url text,
  twitter_url text,
  website_url text,
  source text,
  outreach_status text,
  outreach_notes text,
  contacted_at timestamptz,
  last_activity_at timestamptz,
  enrichment_tried_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  is_company boolean,
  event_count bigint,
  latest_event_at timestamptz,
  latest_event_title text
) AS $$
  SELECT
    h.id, h.name, h.email, h.avatar_url, h.luma_user_id, h.luma_profile_url,
    h.bio, h.company, h.job_title, h.linkedin_url, h.twitter_url, h.website_url,
    h.source, h.outreach_status, h.outreach_notes, h.contacted_at,
    h.last_activity_at, h.enrichment_tried_at, h.created_at, h.updated_at,
    h.is_company,
    COUNT(ehe.source_event_id) AS event_count,
    MAX(ehe.event_start_at) AS latest_event_at,
    (SELECT e.event_title FROM public.event_host_events e
       WHERE e.host_id = h.id ORDER BY e.event_start_at DESC NULLS LAST LIMIT 1) AS latest_event_title
  FROM public.event_hosts h
  LEFT JOIN public.event_host_events ehe ON ehe.host_id = h.id
  WHERE
    (p_search IS NULL OR (
      h.name ILIKE '%' || p_search || '%'
      OR COALESCE(h.company, '') ILIKE '%' || p_search || '%'
      OR COALESCE(h.email, '') ILIKE '%' || p_search || '%'
    ))
    AND (p_status IS NULL OR h.outreach_status = p_status)
    AND (p_include_companies OR h.is_company = false)
  GROUP BY h.id
  ORDER BY COUNT(ehe.source_event_id) DESC, h.updated_at DESC
  LIMIT p_limit OFFSET p_offset;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.event_hosts_with_event_count(text, text, int, int, boolean) TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.event_hosts_with_event_count(text, text, int, int, boolean) TO service_role;
  END IF;
END $$;
