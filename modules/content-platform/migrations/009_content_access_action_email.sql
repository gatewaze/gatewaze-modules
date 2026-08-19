-- ============================================================================
-- content-platform — email-keyed action gate (for service-role callers)
-- ============================================================================
-- content_access_action_allowed uses current_person_is_member (auth.uid()),
-- which a service-role edge function (e.g. events-registration) cannot use — it
-- only has the actor's email. This is the email-keyed twin: is `p_action`
-- allowed on this item for someone with `p_email`? Returns true unless the
-- action is gated AND the email is not a qualifying member (by company domain).
-- Late-binds membership_email_is_member so content-platform keeps no hard
-- dependency on the membership module (absent => gate has no teeth).
--
-- service_role only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.content_access_action_allowed_email(
  p_content_type text,
  p_entity_id    uuid,
  p_action       text,
  p_email        text
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_pol public.content_access_policies;
BEGIN
  v_pol := public.content_access_effective_policy(p_content_type, p_entity_id);
  IF v_pol.content_type IS NULL OR NOT (p_action = ANY(v_pol.gated_actions)) THEN
    RETURN true;                                        -- no policy / action not gated
  END IF;
  IF to_regprocedure('public.membership_email_is_member(text, integer)') IS NULL THEN
    RETURN true;                                        -- no membership system => no teeth
  END IF;
  RETURN public.membership_email_is_member(p_email, v_pol.min_tier_rank);
END $$;
ALTER FUNCTION public.content_access_action_allowed_email(text, uuid, text, text)
  OWNER TO gatewaze_module_writer;
REVOKE ALL ON FUNCTION public.content_access_action_allowed_email(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.content_access_action_allowed_email(text, uuid, text, text) TO service_role;
