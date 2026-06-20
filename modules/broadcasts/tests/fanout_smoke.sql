-- ============================================================================
-- Broadcasts fan-out / claim / event_filters smoke test (re-runnable).
--
-- Validates the send-engine SQL against stub host tables in a THROWAWAY
-- Postgres — never run against a real DB. This is the exact harness used to
-- verify the migrations during the initial build.
--
--   docker rm -f broadcasts-scratch 2>/dev/null
--   docker run -d --name broadcasts-scratch -e POSTGRES_PASSWORD=scratch \
--     supabase/postgres:15.8.1.085
--   # wait for pg_isready, then:
--   docker exec -i broadcasts-scratch psql -U postgres -v ON_ERROR_STOP=1 \
--     < <(cat tests/fanout_smoke.sql \
--           ../broadcasts/migrations/001_broadcasts_tables.sql \
--           ../broadcasts/migrations/002_broadcasts_fanout_claim.sql \
--           ../segments/migrations/003_event_filters.sql \
--           tests/fanout_smoke_assert.sql)
--
-- Expected (verified 2026-06-18):
--   fanned_out = 3 (Dave suppressed)
--   alice America/New_York 09:00 -> 13:00Z ; bob Europe/London 09:00 -> 08:00Z ;
--   carol (no tz) -> 09:00Z ; claim returns 0 while 'scheduled', 3 once 'sending';
--   event_filters → e.event_data->>'event_city' = 'San Francisco' ; re-fanout = 0.
-- ============================================================================

-- --- Stub host objects the migrations depend on (NOT part of the module) ----
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TABLE IF NOT EXISTS public.people (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, attributes jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS public.list_subscriptions (list_id uuid, email text, subscribed boolean DEFAULT true);
CREATE TABLE IF NOT EXISTS public.segments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, definition jsonb NOT NULL DEFAULT '{}'::jsonb, last_calculated_at timestamptz, cached_count int DEFAULT 0);
CREATE TABLE IF NOT EXISTS public.segments_memberships (segment_id uuid, person_id uuid);
CREATE TABLE IF NOT EXISTS public.email_send_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), recipient_email text, newsletter_send_id uuid, sent_at timestamptz, status text);
CREATE TABLE IF NOT EXISTS public.people_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid, event_name text, event_data jsonb DEFAULT '{}'::jsonb, occurred_at timestamptz DEFAULT now());
