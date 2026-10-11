-- Two related hardening steps for the guest-uploads live display
-- (spec-event-media-guest-uploads §6.3 + §14.4):
--
-- 1. Tighten host_media_public_read to require is_approved. Without
--    this, an anon realtime subscriber (postgres_changes respects RLS)
--    would receive unapproved rows for auto_approve=false upload links
--    — a moderation leak. Admin surfaces are unaffected: they read via
--    host_media_admin_all. Legitimate public reads are unaffected in
--    practice because every existing write path defaults
--    is_approved=true.
--
-- 2. Add host_media to the supabase_realtime publication (idempotent
--    guard, newsletters/031 pattern) so the projector display page can
--    subscribe to INSERTs as an accelerator on top of its polling.

DROP POLICY IF EXISTS host_media_public_read ON public.host_media;
CREATE POLICY host_media_public_read ON public.host_media FOR SELECT
  USING (
    access_level = 'public'
    AND is_approved = true
    AND public.can_read_host_media(host_kind, host_id)
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'host_media'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.host_media;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  -- Pooled cloud roles may not own the publication; realtime then stays
  -- off and the display page degrades to polling (by design).
  RAISE NOTICE 'host_media: could not add to supabase_realtime publication (insufficient privilege)';
END $$;
