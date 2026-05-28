-- Migration: 008_event_hosts.sql
-- Adds tables for tracking event hosts (organizers) discovered during scraping.
-- Used for outreach: "reach out to organizer, offer Gatewaze to manage their events."

-- ============================================================================
-- Table: event_hosts
-- One row per unique person across all events. Deduped by luma_user_id when
-- available, otherwise by lower(name) + lower(company). Manual merge is
-- supported by the admin UI when duplicates slip through.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.event_hosts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  email             text,
  avatar_url        text,
  luma_user_id      text UNIQUE,
  luma_profile_url  text,
  bio               text,
  company           text,
  job_title         text,
  linkedin_url      text,
  twitter_url       text,
  website_url       text,
  other_links       jsonb DEFAULT '{}'::jsonb,
  source            text NOT NULL DEFAULT 'luma', -- 'luma' | 'eventbrite' | 'manual' | ...
  outreach_status   text NOT NULL DEFAULT 'new'
                      CHECK (outreach_status IN (
                        'new',         -- discovered, not yet reviewed
                        'enriching',   -- enrichment scraper working on it
                        'ready',       -- reviewed, ready to contact
                        'contacted',   -- outreach sent
                        'responded',   -- they responded (interested or not)
                        'interested',  -- positive signal, in conversation
                        'converted',   -- signed up / now a Gatewaze customer
                        'declined',    -- explicit no
                        'ignored'      -- low-value lead, don't pursue
                      )),
  outreach_notes    text,
  contacted_at      timestamptz,
  contacted_by      uuid REFERENCES auth.users(id),
  last_activity_at  timestamptz,
  enrichment_tried_at timestamptz,
  enrichment_source text,  -- e.g. 'brave_linkedin_search', 'manual'
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_hosts_name_idx ON public.event_hosts (lower(name));
CREATE INDEX IF NOT EXISTS event_hosts_company_idx ON public.event_hosts (lower(company)) WHERE company IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_hosts_status_idx ON public.event_hosts (outreach_status);
CREATE INDEX IF NOT EXISTS event_hosts_updated_idx ON public.event_hosts (updated_at DESC);

-- Fallback uniqueness: when luma_user_id is missing, dedupe on lower(name) + lower(coalesce(company, ''))
CREATE UNIQUE INDEX IF NOT EXISTS event_hosts_name_company_uniq
  ON public.event_hosts (lower(name), lower(COALESCE(company, '')))
  WHERE luma_user_id IS NULL;

-- updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at_event_hosts() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_event_hosts_updated ON public.event_hosts;
CREATE TRIGGER trg_event_hosts_updated
  BEFORE UPDATE ON public.event_hosts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_event_hosts();

-- ============================================================================
-- Table: event_host_events
-- Junction: which events is each host associated with?
-- Uses text event_id to be agnostic to both Luma api_ids and Gatewaze events(id).
-- When an event is imported into Gatewaze's events table, the gatewaze_event_id
-- column is populated so we can link back.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.event_host_events (
  host_id           uuid NOT NULL REFERENCES public.event_hosts(id) ON DELETE CASCADE,
  source_event_id   text NOT NULL,  -- e.g. 'evt-xxx' from Luma, or the scraper's event id
  gatewaze_event_id uuid,            -- set when the event lands in public.events
  event_title       text,
  event_url         text,
  event_start_at    timestamptz,
  calendar_name     text,
  role              text,            -- 'host' | 'co-host' | 'featured_guest'
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, source_event_id)
);

CREATE INDEX IF NOT EXISTS event_host_events_host_idx ON public.event_host_events (host_id);
CREATE INDEX IF NOT EXISTS event_host_events_source_idx ON public.event_host_events (source_event_id);
CREATE INDEX IF NOT EXISTS event_host_events_gatewaze_idx ON public.event_host_events (gatewaze_event_id) WHERE gatewaze_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_host_events_start_idx ON public.event_host_events (event_start_at DESC);

-- ============================================================================
-- RPC: event_hosts_with_event_count
-- Returns hosts with their event count for the admin table. Joins against
-- event_host_events so the UI doesn't need a separate query per row.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.event_hosts_with_event_count(
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit int DEFAULT 100,
  p_offset int DEFAULT 0
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
  event_count bigint,
  latest_event_at timestamptz,
  latest_event_title text
) AS $$
  SELECT
    h.id,
    h.name,
    h.email,
    h.avatar_url,
    h.luma_user_id,
    h.luma_profile_url,
    h.bio,
    h.company,
    h.job_title,
    h.linkedin_url,
    h.twitter_url,
    h.website_url,
    h.source,
    h.outreach_status,
    h.outreach_notes,
    h.contacted_at,
    h.last_activity_at,
    h.enrichment_tried_at,
    h.created_at,
    h.updated_at,
    COUNT(ehe.source_event_id) AS event_count,
    MAX(ehe.event_start_at) AS latest_event_at,
    (
      SELECT e.event_title
      FROM public.event_host_events e
      WHERE e.host_id = h.id
      ORDER BY e.event_start_at DESC NULLS LAST
      LIMIT 1
    ) AS latest_event_title
  FROM public.event_hosts h
  LEFT JOIN public.event_host_events ehe ON ehe.host_id = h.id
  WHERE
    (p_search IS NULL OR (
      h.name ILIKE '%' || p_search || '%'
      OR COALESCE(h.company, '') ILIKE '%' || p_search || '%'
      OR COALESCE(h.email, '') ILIKE '%' || p_search || '%'
    ))
    AND (p_status IS NULL OR h.outreach_status = p_status)
  GROUP BY h.id
  ORDER BY COUNT(ehe.source_event_id) DESC, h.updated_at DESC
  LIMIT p_limit OFFSET p_offset;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================================
-- RPC: event_hosts_events_for_host
-- Returns the events associated with a specific host.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.event_hosts_events_for_host(p_host_id uuid)
RETURNS TABLE (
  source_event_id text,
  gatewaze_event_id uuid,
  event_title text,
  event_url text,
  event_start_at timestamptz,
  calendar_name text,
  role text
) AS $$
  SELECT
    source_event_id,
    gatewaze_event_id,
    event_title,
    event_url,
    event_start_at,
    calendar_name,
    role
  FROM public.event_host_events
  WHERE host_id = p_host_id
  ORDER BY event_start_at DESC NULLS LAST;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================================
-- RPC grants
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.event_hosts_with_event_count(text, text, int, int) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.event_hosts_events_for_host(uuid) TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.event_hosts_with_event_count(text, text, int, int) TO service_role;
    GRANT EXECUTE ON FUNCTION public.event_hosts_events_for_host(uuid) TO service_role;
  END IF;
END $$;
