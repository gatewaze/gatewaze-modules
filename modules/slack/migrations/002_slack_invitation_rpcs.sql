-- ============================================================================
-- 002_slack_invitation_rpcs
--
-- Replicates the gatewaze-admin Slack invitation pipeline inside the slack
-- module. 001_slack_tables.sql created the queue table; this adds the columns
-- and RPCs the worker + request-invite edge function depend on.
--
-- Ported from gatewaze-admin/supabase/migrations/20250119000000_create_slack_invitation_queue.sql
-- (plus the 20260126000001 SECURITY DEFINER fix), prefixed `integrations_` and
-- pointed at public.integrations_slack_invitation_queue.
-- ============================================================================

-- 1. Columns the request RPC / worker expect (admin parity: brand + context).
ALTER TABLE public.integrations_slack_invitation_queue
  ADD COLUMN IF NOT EXISTS account  varchar(50),
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_integrations_slack_invitation_queue_account
  ON public.integrations_slack_invitation_queue (account);

-- 2. Request (enqueue). Dedups against a pending or recently-completed request
--    for the same email so repeat opt-ins don't pile up invites.
CREATE OR REPLACE FUNCTION public.integrations_request_slack_invitation(
  p_email    varchar,
  p_account  varchar DEFAULT 'default',
  p_metadata jsonb   DEFAULT '{}'::jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invitation_id integer;
  v_existing_id   integer;
BEGIN
  SELECT id INTO v_existing_id
  FROM public.integrations_slack_invitation_queue
  WHERE email = p_email
    AND (
      status = 'pending'
      OR (status = 'completed' AND invited_at > NOW() - INTERVAL '7 days')
    )
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

  INSERT INTO public.integrations_slack_invitation_queue (email, account, status, metadata)
  VALUES (p_email, p_account, 'pending', p_metadata)
  RETURNING id INTO v_invitation_id;

  RETURN v_invitation_id;
END;
$$;

-- 3. Get pending invitations (queue processor / worker).
CREATE OR REPLACE FUNCTION public.integrations_get_pending_slack_invitations(
  limit_count integer DEFAULT 10
)
RETURNS TABLE (
  id          integer,
  email       varchar,
  account     varchar,
  retry_count integer,
  created_at  timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT si.id, si.email, si.account, si.retry_count, si.created_at
  FROM public.integrations_slack_invitation_queue si
  WHERE si.status = 'pending'
  ORDER BY si.created_at ASC
  LIMIT limit_count;
END;
$$;

-- 4. Update invitation status (worker reports progress/outcome).
CREATE OR REPLACE FUNCTION public.integrations_update_slack_invitation_status(
  p_invitation_id integer,
  p_status        varchar,
  p_error_message text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.integrations_slack_invitation_queue
  SET
    status        = p_status,
    error_message = p_error_message,
    invited_at    = CASE WHEN p_status = 'completed' THEN NOW() ELSE invited_at END,
    retry_count   = CASE WHEN p_status = 'failed' THEN retry_count + 1 ELSE retry_count END
  WHERE id = p_invitation_id;
END;
$$;

-- 5. Stats (admin dashboard).
CREATE OR REPLACE FUNCTION public.integrations_get_slack_invitation_stats()
RETURNS TABLE (
  account            varchar,
  total_requests     bigint,
  pending_count      bigint,
  completed_count    bigint,
  failed_count       bigint,
  last_invitation_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    si.account,
    COUNT(*)::bigint,
    COUNT(*) FILTER (WHERE si.status = 'pending')::bigint,
    COUNT(*) FILTER (WHERE si.status = 'completed')::bigint,
    COUNT(*) FILTER (WHERE si.status = 'failed')::bigint,
    MAX(si.invited_at)
  FROM public.integrations_slack_invitation_queue si
  GROUP BY si.account
  ORDER BY si.account;
END;
$$;

-- Worker + request-invite edge function run as service_role; admin UI as authenticated.
GRANT EXECUTE ON FUNCTION public.integrations_request_slack_invitation(varchar, varchar, jsonb)      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.integrations_get_pending_slack_invitations(integer)                 TO service_role;
GRANT EXECUTE ON FUNCTION public.integrations_update_slack_invitation_status(integer, varchar, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.integrations_get_slack_invitation_stats()                           TO service_role, authenticated;
