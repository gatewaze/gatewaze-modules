-- ============================================================================
-- Module: bulk-emailing
-- Migration: 016_bulk_update_interaction_scores_rpc
-- Description: Bulk-update RPC that the email-bot-detector-signals backfill
-- script uses to write many email_interactions score rows in one round-trip.
--
-- PostgREST upsert (POST with Prefer: resolution=merge-duplicates) requires
-- the full row payload — including FK columns like email_send_log_id —
-- otherwise it tries to INSERT and the NOT NULL constraint fires. PATCH
-- can only set ONE value per call. A SECURITY DEFINER RPC that takes a
-- jsonb array and does UPDATE FROM jsonb_to_recordset gets us bulk
-- per-row updates without the wide payload.
--
-- Created ad-hoc on AAIF prod 2026-06-23 to support the one-off scoring
-- backfill of ~30k unscored email_interactions; this migration codifies
-- the function so future installs have it without manual setup.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bulk_update_email_interaction_scores(p_updates jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  UPDATE public.email_interactions e SET
    human_confidence = m.human_confidence,
    bot_signals      = m.bot_signals,
    scorer_id        = m.scorer_id,
    scored_at        = m.scored_at
  FROM jsonb_to_recordset(p_updates)
       AS m(id uuid, human_confidence numeric, bot_signals jsonb, scorer_id text, scored_at timestamptz)
  WHERE e.id = m.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

GRANT EXECUTE ON FUNCTION public.bulk_update_email_interaction_scores(jsonb) TO service_role;

COMMENT ON FUNCTION public.bulk_update_email_interaction_scores(jsonb) IS
  'Bulk-update scoring columns on email_interactions from a jsonb array of {id, human_confidence, bot_signals, scorer_id, scored_at}. Used by email-bot-detector-signals/scripts/backfill-interaction-scores.ts.';
