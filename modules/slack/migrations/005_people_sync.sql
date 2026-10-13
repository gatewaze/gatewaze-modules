-- ============================================================================
-- 005_people_sync
--
-- Link Slack members to people. A member is matched to a person by email and
-- the link is stored as attributes.slack_user_id — Slack's user ID, which
-- Slack's UI also calls the "member ID". Depending on the module's
-- SLACK_PEOPLE_SYNC setting, a member nobody has yet becomes a new person.
--
--   integrations_slack_link_members(members, create, source)
--       Links a batch (at most 1000) and reports what it did per member.
--       Used for each join and by the full-workspace sync.
--   integrations_slack_member_syncs
--       One row per full-workspace sync, for the admin page.
--
-- Service role only, like 004.
-- ============================================================================

-- Lookups by Slack user ID (re-linking, admin views). Partial: most people
-- have no Slack account.
CREATE INDEX IF NOT EXISTS idx_people_slack_user_id
  ON public.people ((attributes->>'slack_user_id'))
  WHERE attributes ? 'slack_user_id';

CREATE TABLE IF NOT EXISTS public.integrations_slack_member_syncs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode         text NOT NULL CHECK (mode IN ('link', 'create')),
  status       text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'done', 'failed')),
  started_by   uuid,
  started_at   timestamptz,
  finished_at  timestamptz,
  pages        integer NOT NULL DEFAULT 0,
  members_seen integer NOT NULL DEFAULT 0,
  -- Per-result counts from integrations_slack_link_members:
  -- created / updated / unchanged / unmatched / no_email / invalid.
  results      jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slack_member_syncs_created_at
  ON public.integrations_slack_member_syncs (created_at DESC);

DROP TRIGGER IF EXISTS set_updated_at ON public.integrations_slack_member_syncs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.integrations_slack_member_syncs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.integrations_slack_member_syncs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integrations_slack_member_syncs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.integrations_slack_member_syncs TO service_role;

-- ----------------------------------------------------------------------------
-- integrations_slack_link_members
--
-- p_members: [{slack_user_id, email, first_name, last_name, username}, ...]
-- p_create:  add a person for a member whose email matches nobody.
-- p_source:  acquisition_source for a person created here.
--
-- For a matched person it writes slack_user_id and slack_username, and fills
-- first_name / last_name only where the person has none: Slack is the
-- authority on which account an address belongs to, not on someone's name.
-- Each attribute it changes gets a fresh attribute_timestamps entry, as every
-- other writer of people.attributes does. Nothing changes when nothing differs.
--
-- Matching is on lower(email), preferring an exact match: a handful of people
-- rows differ only by case.
--
-- Returns one row per input member: r_action is created, updated, unchanged,
-- unmatched (p_create off), no_email or invalid.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.integrations_slack_link_members(
  p_members jsonb,
  p_create  boolean DEFAULT false,
  p_source  text    DEFAULT 'Slack'
)
RETURNS TABLE (r_slack_user_id text, r_person_id uuid, r_action text)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  m        jsonb;
  v_id     text;
  v_email  text;
  v_first  text;
  v_last   text;
  v_user   text;
  v_pid    uuid;
  v_attrs  jsonb;
  v_patch  jsonb;
  v_now    jsonb := to_jsonb(extract(epoch FROM now())::bigint);
BEGIN
  IF p_members IS NULL OR jsonb_typeof(p_members) <> 'array' THEN
    RAISE EXCEPTION 'p_members must be a JSON array';
  END IF;
  IF jsonb_array_length(p_members) > 1000 THEN
    RAISE EXCEPTION 'at most 1000 members per call';
  END IF;

  FOR m IN SELECT value FROM jsonb_array_elements(p_members) LOOP
    v_id    := m->>'slack_user_id';
    v_email := lower(btrim(m->>'email'));
    v_first := left(nullif(btrim(m->>'first_name'), ''), 200);
    v_last  := left(nullif(btrim(m->>'last_name'), ''), 200);
    v_user  := left(nullif(btrim(m->>'username'), ''), 200);
    r_slack_user_id := v_id;
    r_person_id := NULL;

    IF v_id IS NULL OR v_id !~ '^[UW][A-Z0-9]{2,20}$' THEN
      r_action := 'invalid';
      RETURN NEXT;
      CONTINUE;
    END IF;
    IF v_email IS NULL OR length(v_email) > 254 OR v_email !~ '^[^@[:space:],<>]+@[^@[:space:],<>]+\.[^@[:space:],<>]+$' THEN
      r_action := 'no_email';
      RETURN NEXT;
      CONTINUE;
    END IF;

    v_pid := NULL;
    SELECT p.id, coalesce(p.attributes, '{}'::jsonb) INTO v_pid, v_attrs
      FROM public.people p
     WHERE lower(p.email) = v_email
     ORDER BY (p.email = v_email) DESC, p.created_at
     LIMIT 1;

    IF v_pid IS NULL THEN
      IF NOT p_create THEN
        r_action := 'unmatched';
        RETURN NEXT;
        CONTINUE;
      END IF;

      v_patch := jsonb_strip_nulls(jsonb_build_object(
        'slack_user_id',  v_id,
        'slack_username', v_user,
        'first_name',     v_first,
        'last_name',      v_last,
        'source',         'slack'
      ));
      INSERT INTO public.people (email, contact_kind, acquisition_source, attributes, attribute_timestamps)
      VALUES (
        v_email, 'member', left(coalesce(nullif(btrim(p_source), ''), 'Slack'), 100), v_patch,
        (SELECT jsonb_object_agg(k, v_now) FROM jsonb_object_keys(v_patch) AS k)
      )
      ON CONFLICT (email) DO NOTHING
      RETURNING id INTO v_pid;

      IF v_pid IS NOT NULL THEN
        UPDATE public.integrations_slack_welcome_log SET person_id = v_pid
         WHERE slack_user_id = v_id AND person_id IS NULL;
        r_person_id := v_pid;
        r_action := 'created';
        RETURN NEXT;
        CONTINUE;
      END IF;

      -- Lost a race with another insert of the same address: link to it.
      SELECT p.id, coalesce(p.attributes, '{}'::jsonb) INTO v_pid, v_attrs
        FROM public.people p WHERE p.email = v_email;
      IF v_pid IS NULL THEN
        r_action := 'unmatched';
        RETURN NEXT;
        CONTINUE;
      END IF;
    END IF;

    -- Only the keys whose value actually changes.
    SELECT jsonb_object_agg(e.key, e.value) INTO v_patch
      FROM jsonb_each(jsonb_strip_nulls(jsonb_build_object(
             'slack_user_id',  v_id,
             'slack_username', v_user,
             'first_name',     CASE WHEN nullif(btrim(v_attrs->>'first_name'), '') IS NULL THEN v_first END,
             'last_name',      CASE WHEN nullif(btrim(v_attrs->>'last_name'), '') IS NULL THEN v_last END
           ))) AS e
     WHERE v_attrs->e.key IS DISTINCT FROM e.value;

    IF v_patch IS NULL THEN
      r_action := 'unchanged';
    ELSE
      UPDATE public.people
         SET attributes = coalesce(attributes, '{}'::jsonb) || v_patch,
             attribute_timestamps = coalesce(attribute_timestamps, '{}'::jsonb)
               || (SELECT jsonb_object_agg(k, v_now) FROM jsonb_object_keys(v_patch) AS k)
       WHERE id = v_pid;
      r_action := 'updated';
    END IF;

    UPDATE public.integrations_slack_welcome_log SET person_id = v_pid
     WHERE slack_user_id = v_id AND person_id IS NULL;
    r_person_id := v_pid;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.integrations_slack_link_members(jsonb, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integrations_slack_link_members(jsonb, boolean, text) TO service_role;
