-- Newsletter Geo & Timezone Engagement Reporting — config + indexes
-- Spec: gatewaze-environments/specs/spec-newsletter-geo-engagement-reporting.md (§3, §7.7, §10)
--
-- Adds the single-row tunables table and the read-path indexes that the geo
-- reporting RPCs (migration 050) rely on. Purely additive.
--
-- Down (for reference; not auto-run):
--   DROP TABLE IF EXISTS public.newsletter_geo_config;
--   DROP INDEX IF EXISTS public.idx_email_interactions_geo_clicks;
--   DROP INDEX IF EXISTS public.idx_email_interactions_geo_opens;
--   DROP INDEX IF EXISTS public.idx_email_interactions_geo_block;

-- ── Config (single row; §3 named constants) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.newsletter_geo_config (
  id                        boolean PRIMARY KEY DEFAULT true CHECK (id),  -- single row
  k_anonymity_min           integer NOT NULL DEFAULT 15  CHECK (k_anonymity_min >= 1),
  open_human_confidence_min numeric NOT NULL DEFAULT 0.5  CHECK (open_human_confidence_min BETWEEN 0 AND 1),
  top_n_regions             integer NOT NULL DEFAULT 12  CHECK (top_n_regions >= 1),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.newsletter_geo_config (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;

GRANT SELECT ON public.newsletter_geo_config TO authenticated;

-- ── Read-path indexes on email_interactions ────────────────────────────────
-- NOTE: on production, create these CONCURRENTLY out-of-band to avoid locking
-- email_interactions (CONCURRENTLY cannot run inside the migration/exec_sql
-- transaction). Locally the table is small/empty so a plain build is fine.

-- Clicks (no confidence gate) + block attribution for R3/R4.
CREATE INDEX IF NOT EXISTS idx_email_interactions_geo_block
  ON public.email_interactions (edition_id, block_id, event_type)
  WHERE is_bot IS NOT TRUE;

-- Clicks by edition for R1/R5.
CREATE INDEX IF NOT EXISTS idx_email_interactions_geo_clicks
  ON public.email_interactions (edition_id, event_type, ip_geo_country)
  WHERE is_bot IS NOT TRUE AND event_type = 'click';

-- Opens carry the human-confidence gate; a separate partial index keeps the
-- predicate aligned with OPEN_HUMAN_CONFIDENCE_MIN (default 0.5). If that
-- constant is retuned, recreate this index (see spec §16). A test asserts the
-- config value matches this literal.
CREATE INDEX IF NOT EXISTS idx_email_interactions_geo_opens
  ON public.email_interactions (edition_id, event_type, ip_geo_country)
  WHERE is_bot IS NOT TRUE AND event_type = 'open' AND human_confidence >= 0.5;

-- Functional index so the geo RPCs can nested-loop people by case-insensitive
-- email (delivered recipients → profile region) instead of seq-scanning all
-- ~156k people. people is owned by supabase_admin → create via exec_sql on prod.
CREATE INDEX IF NOT EXISTS idx_people_lower_email
  ON public.people (lower(email));
