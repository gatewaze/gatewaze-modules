-- ============================================================================
-- 003_portal_self_service
--
-- Lets a signed-in portal visitor ask for their own Slack invitation and see
-- where it is, without ever naming an address the server has not verified as
-- theirs. Adds a public-info RPC for the page copy, closes the queue's
-- read-everything SELECT policy, and closes the base request RPC, which any
-- signed-in user could call with any address.
--
-- Identity comes from the request JWT via current_setting (pg_catalog), not
-- auth.uid(): SECURITY DEFINER functions here must not depend on the auth
-- schema (see membership/022 for the same reasoning).
-- ============================================================================

-- 1. JWT helpers ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.integrations_slack_jwt_uid()
RETURNS uuid
LANGUAGE sql STABLE AS $$
  -- A malformed sub must read as "not signed in", not a 500 from the cast.
  SELECT CASE WHEN v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v::uuid END
  FROM (SELECT COALESCE(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  ) AS v) s
$$;

CREATE OR REPLACE FUNCTION public.integrations_slack_jwt_email()
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT lower(COALESCE(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'
  ))
$$;

REVOKE ALL ON FUNCTION public.integrations_slack_jwt_uid() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.integrations_slack_jwt_email() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integrations_slack_jwt_uid() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integrations_slack_jwt_email() TO authenticated, service_role;

-- 2. The caller's addresses: the JWT email plus the linked person's email.
--    Returned lower-cased and de-duplicated; the person's email first.
CREATE OR REPLACE FUNCTION public.integrations_slack_my_emails()
RETURNS TABLE(email text, is_primary boolean)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT public.integrations_slack_jwt_uid() AS uid, public.integrations_slack_jwt_email() AS jwt_email
  ),
  candidates AS (
    SELECT lower(p.email) AS email, 0 AS rank
    FROM public.people p, me
    WHERE me.uid IS NOT NULL AND p.auth_user_id = me.uid AND p.email IS NOT NULL
    UNION ALL
    SELECT me.jwt_email, 1 FROM me WHERE me.jwt_email IS NOT NULL
  )
  SELECT email, (min(rank) = 0) AS is_primary
  FROM candidates
  WHERE email ~ '^[^@\s,]+@[^@\s,]+\.[^@\s,]+$'
  GROUP BY email
  ORDER BY min(rank), email
$$;

REVOKE ALL ON FUNCTION public.integrations_slack_my_emails() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integrations_slack_my_emails() TO authenticated, service_role;

-- 3. Status for the caller only. Returns the latest row per address with a
--    coarse outcome; the worker's raw error text is never exposed.
CREATE OR REPLACE FUNCTION public.integrations_my_slack_invitations()
RETURNS jsonb
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH mine AS (SELECT email, is_primary FROM public.integrations_slack_my_emails()),
  latest AS (
    SELECT DISTINCT ON (lower(q.email))
      lower(q.email) AS email,
      q.status,
      q.error_message,
      q.invited_at,
      q.created_at,
      q.updated_at
    FROM public.integrations_slack_invitation_queue q
    JOIN mine m ON m.email = lower(q.email)
    ORDER BY lower(q.email), q.created_at DESC, q.id DESC
  )
  SELECT jsonb_build_object(
    'emails', COALESCE((SELECT jsonb_agg(jsonb_build_object('email', email, 'is_primary', is_primary) ORDER BY is_primary DESC, email) FROM mine), '[]'::jsonb),
    'invitations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'email', email,
        'outcome', CASE
          WHEN status IN ('pending', 'processing') THEN 'queued'
          WHEN status = 'completed' AND error_message ILIKE 'User already%' THEN 'member'
          WHEN status = 'completed' THEN 'sent'
          ELSE 'failed'
        END,
        'invited_at', invited_at,
        'requested_at', created_at,
        'updated_at', updated_at
      ) ORDER BY created_at DESC)
      FROM latest), '[]'::jsonb)
  )
$$;

REVOKE ALL ON FUNCTION public.integrations_my_slack_invitations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integrations_my_slack_invitations() TO authenticated, service_role;

-- 4. Request an invitation for the caller. The address must be one the server
--    resolved for this JWT; the dedupe and insert reuse the base RPC.
CREATE OR REPLACE FUNCTION public.integrations_request_my_slack_invitation(
  p_email   text    DEFAULT NULL,
  p_account varchar DEFAULT 'default'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid := public.integrations_slack_jwt_uid();
  v_email     text;
  v_person_id uuid;
  v_metadata  jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to request a Slack invitation' USING ERRCODE = '28000';
  END IF;

  IF p_account IS NULL OR p_account !~ '^[a-z0-9_-]{1,50}$' THEN
    RAISE EXCEPTION 'Invalid account' USING ERRCODE = '22023';
  END IF;

  IF p_email IS NULL OR btrim(p_email) = '' THEN
    SELECT email INTO v_email FROM public.integrations_slack_my_emails() ORDER BY is_primary DESC, email LIMIT 1;
  ELSE
    SELECT email INTO v_email FROM public.integrations_slack_my_emails() WHERE email = lower(btrim(p_email));
  END IF;

  IF v_email IS NULL THEN
    RAISE EXCEPTION 'That address is not linked to your account' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_person_id FROM public.people WHERE auth_user_id = v_uid ORDER BY created_at LIMIT 1;

  v_metadata := jsonb_strip_nulls(jsonb_build_object(
    'source', 'portal',
    'person_id', v_person_id,
    'auth_user_id', v_uid
  ));

  RETURN public.integrations_request_slack_invitation(v_email::varchar, p_account, v_metadata);
END;
$$;

REVOKE ALL ON FUNCTION public.integrations_request_my_slack_invitation(text, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integrations_request_my_slack_invitation(text, varchar) TO authenticated, service_role;

-- 5. Public page copy: only the non-secret keys, readable by anyone.
CREATE OR REPLACE FUNCTION public.integrations_slack_public_info()
RETURNS jsonb
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT jsonb_strip_nulls(jsonb_build_object(
      'workspace_name', config ->> 'SLACK_WORKSPACE_NAME',
      'workspace_url',  config ->> 'SLACK_WORKSPACE_URL',
      'description',    config ->> 'SLACK_COMMUNITY_DESCRIPTION',
      'channels',       config ->> 'SLACK_HIGHLIGHT_CHANNELS'
    ))
    FROM public.installed_modules
    WHERE id = 'slack'
  ), '{}'::jsonb)
$$;

REVOKE ALL ON FUNCTION public.integrations_slack_public_info() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.integrations_slack_public_info() TO anon, authenticated, service_role;

-- 6. The queue held every invitee's address readable by any signed-in user.
--    Admins read it through the admin UI; everyone else goes through the
--    scoped RPC above.
DROP POLICY IF EXISTS "integrations_slack_invitation_queue_select" ON public.integrations_slack_invitation_queue;
CREATE POLICY "integrations_slack_invitation_queue_select"
  ON public.integrations_slack_invitation_queue
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- 7. The base request RPC took any address from any signed-in user (SECURITY
--    DEFINER, so the admin-only INSERT policy never applied). Signed-in callers
--    now go through the self-service RPC above; admins through this checked
--    wrapper; the worker and edge function keep service_role.
CREATE OR REPLACE FUNCTION public.integrations_admin_request_slack_invitation(
  p_email    varchar,
  p_account  varchar DEFAULT 'default',
  p_metadata jsonb   DEFAULT '{}'::jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admins only' USING ERRCODE = '42501';
  END IF;
  IF p_email IS NULL OR lower(btrim(p_email)) !~ '^[^@\s,]+@[^@\s,]+\.[^@\s,]+$' THEN
    RAISE EXCEPTION 'Invalid email' USING ERRCODE = '22023';
  END IF;
  IF p_account IS NULL OR p_account !~ '^[a-z0-9_-]{1,50}$' THEN
    RAISE EXCEPTION 'Invalid account' USING ERRCODE = '22023';
  END IF;
  RETURN public.integrations_request_slack_invitation(
    lower(btrim(p_email))::varchar, p_account,
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('source', 'admin', 'requested_by', public.integrations_slack_jwt_uid())
  );
END;
$$;

REVOKE ALL ON FUNCTION public.integrations_admin_request_slack_invitation(varchar, varchar, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integrations_admin_request_slack_invitation(varchar, varchar, jsonb) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.integrations_request_slack_invitation(varchar, varchar, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.integrations_request_slack_invitation(varchar, varchar, jsonb) TO service_role;

-- Queue statistics are an admin concern; the admin page reads them through the API.
REVOKE EXECUTE ON FUNCTION public.integrations_get_slack_invitation_stats() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.integrations_get_slack_invitation_stats() TO service_role;
