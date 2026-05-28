-- ============================================================================
-- Module: competitions
-- Migration: 003_winner_lifecycle
-- Description: Extend events_competition_winners with the lifecycle, status,
--              and media fields used by the original gatewaze-admin
--              implementation. Allows winners to be tracked by (email, event_id)
--              alongside the relational (person_id, competition_id, entry_id)
--              identity, so the existing flat-key API surface continues to work.
-- ============================================================================

-- ==========================================================================
-- 1. Make relational FKs nullable so winners can be created from a flat
--    (email, event_id) workflow without requiring a competition + entry row
--    to exist first. The relational columns remain available for new code.
-- ==========================================================================
ALTER TABLE public.events_competition_winners
  ALTER COLUMN competition_id DROP NOT NULL,
  ALTER COLUMN entry_id DROP NOT NULL,
  ALTER COLUMN person_id DROP NOT NULL;

-- ==========================================================================
-- 2. Add flat identity + lifecycle + media columns
-- ==========================================================================
ALTER TABLE public.events_competition_winners
  ADD COLUMN IF NOT EXISTS email                     varchar(255),
  ADD COLUMN IF NOT EXISTS event_id                  varchar(255),
  ADD COLUMN IF NOT EXISTS status                    varchar(20) NOT NULL DEFAULT 'notified',
  ADD COLUMN IF NOT EXISTS accepted_at               timestamptz,
  ADD COLUMN IF NOT EXISTS declined_at               timestamptz,
  ADD COLUMN IF NOT EXISTS not_replied_at            timestamptz,
  ADD COLUMN IF NOT EXISTS winner_image_url          text,
  ADD COLUMN IF NOT EXISTS winner_image_storage_path text,
  ADD COLUMN IF NOT EXISTS social_post_url           text,
  ADD COLUMN IF NOT EXISTS social_post_platform      text,
  ADD COLUMN IF NOT EXISTS notes                     text,
  ADD COLUMN IF NOT EXISTS media_updated_at          timestamptz;

-- Status check constraint — added separately so existing rows (which default
-- to 'notified') don't violate it.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'events_competition_winners_status_check'
  ) THEN
    ALTER TABLE public.events_competition_winners
      ADD CONSTRAINT events_competition_winners_status_check
      CHECK (status IN ('selected', 'notified', 'accepted', 'declined', 'not_replied'));
  END IF;
END $$;

COMMENT ON COLUMN public.events_competition_winners.email IS
  'Email address of the winner — flat identity, kept in sync with people.email when person_id is set';
COMMENT ON COLUMN public.events_competition_winners.event_id IS
  'Event the win is associated with — flat identity, mirrors competitions.event_id when competition_id is set';
COMMENT ON COLUMN public.events_competition_winners.status IS
  'Winner lifecycle status: selected → notified → accepted/declined/not_replied';
COMMENT ON COLUMN public.events_competition_winners.winner_image_url IS
  'Public URL to the winner image stored in the media bucket';
COMMENT ON COLUMN public.events_competition_winners.winner_image_storage_path IS
  'Storage path inside the media bucket (typically winner-images/<file>)';
COMMENT ON COLUMN public.events_competition_winners.social_post_url IS
  'URL to a social media post celebrating the win';
COMMENT ON COLUMN public.events_competition_winners.social_post_platform IS
  'Social media platform key (twitter, linkedin, instagram, etc.)';
COMMENT ON COLUMN public.events_competition_winners.notes IS
  'Free-form notes about the winner or their submission';
COMMENT ON COLUMN public.events_competition_winners.media_updated_at IS
  'Timestamp of the most recent media update';

-- ==========================================================================
-- 3. Indexes (matching the old gatewaze-admin baseline)
-- ==========================================================================
CREATE INDEX IF NOT EXISTS idx_events_competition_winners_email
  ON public.events_competition_winners (email);
CREATE INDEX IF NOT EXISTS idx_events_competition_winners_event_id
  ON public.events_competition_winners (event_id);
CREATE INDEX IF NOT EXISTS idx_events_competition_winners_email_event
  ON public.events_competition_winners (email, event_id);
CREATE INDEX IF NOT EXISTS idx_events_competition_winners_status
  ON public.events_competition_winners (status);

-- ==========================================================================
-- 4. Partial unique constraint on (email, event_id)
--    Prevents the same person winning the same event twice via the flat API,
--    while still allowing multiple winners that only carry the relational
--    identity (legacy + new code coexist).
-- ==========================================================================
CREATE UNIQUE INDEX IF NOT EXISTS events_competition_winners_email_event_unique
  ON public.events_competition_winners (email, event_id)
  WHERE email IS NOT NULL AND event_id IS NOT NULL;

-- ==========================================================================
-- 5. Storage: winner images live under the shared `media` bucket inside a
--    `winner-images/` prefix. The bucket itself is created/owned by the
--    platform; this migration only ensures the bucket row exists and that
--    objects under the winner-images/ prefix have the right RLS.
-- ==========================================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('media', 'media', true)
ON CONFLICT (id) DO NOTHING;

-- Drop & recreate winner-images RLS policies on storage.objects
DROP POLICY IF EXISTS "winner_images_authenticated_insert" ON storage.objects;
DROP POLICY IF EXISTS "winner_images_authenticated_update" ON storage.objects;
DROP POLICY IF EXISTS "winner_images_authenticated_delete" ON storage.objects;
DROP POLICY IF EXISTS "winner_images_public_select"        ON storage.objects;

CREATE POLICY "winner_images_authenticated_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'media' AND name LIKE 'winner-images/%');

CREATE POLICY "winner_images_authenticated_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'media' AND name LIKE 'winner-images/%');

CREATE POLICY "winner_images_authenticated_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'media' AND name LIKE 'winner-images/%');

CREATE POLICY "winner_images_public_select"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'media' AND name LIKE 'winner-images/%');

-- ==========================================================================
-- 6. RPC: events_get_total_competition_value()
--    Sums the offer_value of every accepted competition winner, converting
--    GBP/EUR/INR to USD using static exchange rates. Used by the competitions
--    admin dashboard to surface a "total value saved" stat. Ported from
--    gatewaze-admin's get_total_competition_value_saved_usd() function and
--    updated for the new schema (events.event_id varchar join,
--    events_competition_winners table name).
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.events_get_total_competition_value()
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  total_usd  NUMERIC := 0;
  rec        RECORD;
  clean_val  TEXT;
  amount     NUMERIC;
  usd_amount NUMERIC;
  -- Static FX rates (matching legacy behaviour). Refresh periodically.
  gbp_to_usd CONSTANT NUMERIC := 1.27;
  eur_to_usd CONSTANT NUMERIC := 1.10;
  inr_to_usd CONSTANT NUMERIC := 0.012;
BEGIN
  FOR rec IN
    SELECT
      e.event_id,
      e.event_title,
      e.offer_value,
      COUNT(cw.id) AS winner_count
    FROM public.events e
    INNER JOIN public.events_competition_winners cw
      ON cw.event_id = e.event_id
    WHERE e.offer_value     IS NOT NULL
      AND e.offer_value     <> ''
      AND cw.accepted_at    IS NOT NULL
    GROUP BY e.event_id, e.event_title, e.offer_value
  LOOP
    -- Strip currency symbols and thousands separators
    clean_val := REGEXP_REPLACE(rec.offer_value, '[£€$₹,]', '', 'g');

    BEGIN
      amount := clean_val::NUMERIC;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;

    -- Determine currency from the original symbol
    IF    rec.offer_value LIKE '%£%' THEN usd_amount := amount * gbp_to_usd;
    ELSIF rec.offer_value LIKE '%€%' THEN usd_amount := amount * eur_to_usd;
    ELSIF rec.offer_value LIKE '%₹%' THEN usd_amount := amount * inr_to_usd;
    ELSIF rec.offer_value LIKE '%$%' THEN usd_amount := amount;
    ELSE                                  usd_amount := amount;
    END IF;

    total_usd := total_usd + (usd_amount * rec.winner_count);
  END LOOP;

  RETURN ROUND(total_usd, 2);
END;
$$;

GRANT EXECUTE ON FUNCTION public.events_get_total_competition_value() TO authenticated;
