-- ============================================================================
-- Module: event-tracking
-- Migration: 003_touch_session_only
-- Description: Close the direct-UPDATE route 002 left open for browsers.
--              The portal now calls event_tracking_touch_session for the two
--              post-insert marks, so the column UPDATE grant, the UPDATE
--              policy and the anon SELECT policy/grant (which existed only to
--              make that UPDATE match rows) are removed. A browser can no
--              longer list session ids or overwrite email_hash on any row.
--              The RPC becomes first-write-wins on email_hash and returns
--              nothing, so it cannot be used to probe which ids exist.
-- ============================================================================

REVOKE UPDATE ON public.integrations_ad_tracking_sessions FROM anon, authenticated;
REVOKE SELECT ON public.integrations_ad_tracking_sessions FROM anon;

DROP POLICY IF EXISTS "ad_tracking_sessions_update_browser" ON public.integrations_ad_tracking_sessions;
DROP POLICY IF EXISTS "ad_tracking_sessions_select_anon" ON public.integrations_ad_tracking_sessions;

DROP FUNCTION IF EXISTS public.event_tracking_touch_session(text, boolean, text);

CREATE OR REPLACE FUNCTION public.event_tracking_touch_session(
  p_session_id        text,
  p_external_redirect boolean DEFAULT false,
  p_email_hash        text    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_session_id IS NULL OR p_session_id !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RETURN;
  END IF;
  IF p_email_hash IS NOT NULL AND p_email_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  UPDATE public.integrations_ad_tracking_sessions
     SET external_redirect_at = CASE WHEN p_external_redirect THEN coalesce(external_redirect_at, now()) ELSE external_redirect_at END,
         -- first write wins: a session's email can be set once, never replaced
         email_hash           = coalesce(email_hash, p_email_hash)
   WHERE session_id = p_session_id
     AND status = 'pending'
     AND (expires_at IS NULL OR expires_at > now());
END;
$$;

REVOKE ALL ON FUNCTION public.event_tracking_touch_session(text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.event_tracking_touch_session(text, boolean, text) TO anon, authenticated, service_role;
