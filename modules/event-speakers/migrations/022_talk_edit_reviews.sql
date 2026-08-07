-- ============================================================================
-- Module: event-speakers
-- Migration: 022_talk_edit_reviews
-- Description: Makes the "speaker edited their talk" status reset lenient.
--
--              Today ANY change to title or synopsis knocks an approved or
--              confirmed talk back to 'pending', so fixing a typo costs the
--              speaker their slot until an organiser re-reviews.
--
--              The edge function still resets immediately — that is the
--              fail-safe default and must not depend on AI being reachable.
--              It now also records the edit here, and a worker judges whether
--              the change actually altered the substance of the talk. A minor
--              edit is restored to the previous status automatically; a
--              material one stays pending for a human.
--
--              The old/new text is kept so an organiser can see exactly what
--              changed and why the judgement went the way it did — the AI's
--              reasoning is advisory, not a black box.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.speaker_talk_edit_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  talk_id uuid NOT NULL REFERENCES public.events_talks(id) ON DELETE CASCADE,
  -- Status to restore when the edit turns out to be minor.
  previous_status text NOT NULL,
  old_title text,
  new_title text,
  old_synopsis text,
  new_synopsis text,
  -- pending → the worker hasn't judged yet
  -- minor    → substance unchanged; previous_status was restored
  -- material → substance changed; the talk stays pending for re-review
  -- failed   → judgement unavailable; the talk stays pending (fail-safe)
  verdict text NOT NULL DEFAULT 'pending'
    CHECK (verdict IN ('pending', 'minor', 'material', 'failed')),
  reason text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  judged_at timestamptz
);

-- The sweep claims oldest-first; this keeps that scan cheap.
CREATE INDEX IF NOT EXISTS idx_talk_edit_reviews_pending
  ON public.speaker_talk_edit_reviews (created_at)
  WHERE verdict = 'pending';

CREATE INDEX IF NOT EXISTS idx_talk_edit_reviews_talk
  ON public.speaker_talk_edit_reviews (talk_id);

ALTER TABLE public.speaker_talk_edit_reviews ENABLE ROW LEVEL SECURITY;

-- Service role (edge function + worker) writes. Active admins read, so the
-- Speakers tab can explain why a talk did or didn't go back to pending.
-- No anon/authenticated-at-large access: this holds unpublished talk content.
DROP POLICY IF EXISTS talk_edit_reviews_service ON public.speaker_talk_edit_reviews;
CREATE POLICY talk_edit_reviews_service ON public.speaker_talk_edit_reviews
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS talk_edit_reviews_admin_read ON public.speaker_talk_edit_reviews;
CREATE POLICY talk_edit_reviews_admin_read ON public.speaker_talk_edit_reviews
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.admin_profiles ap
    WHERE ap.user_id = auth.uid() AND ap.is_active = true
  ));
