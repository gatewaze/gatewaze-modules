-- ============================================================================
-- Module: segments
-- Migration: 021_email_activity_condition
-- Description: an 'email_activity' condition source for a person's activity
-- across ALL email, not one campaign: "opened or clicked any email in the last
-- 90 days", "was never sent anything", "replied to any email". It lets an
-- admin split an audience into engagement tiers in the builder, e.g. to send
-- to engaged Gmail readers first when a domain's Gmail reputation is weak.
--
-- Operators carry the action and its polarity:
--   opened_or_clicked / not_opened_or_clicked
--   was_sent / not_sent
--   replied / not_replied   (broadcast, newsletter and event replies,
--                            auto-replies ignored)
-- Param within_days (optional, 1 to 3650): only count activity in that many
-- days. Blank means at any time.
--
-- Activity comes from segments_email_activity, one row per address with its
-- latest send, open, click and reply. Reading email_send_log directly took
-- 26s or more on AAIF (6M rows, 15 GB), far past the 8s preview limit. The
-- worker 'segments:refresh-email-activity' rebuilds the table every 2 hours,
-- so activity can be up to that old.
--
-- The compiled predicate calls segments_email_activity_has(), a plpgsql
-- function the planner cannot inline. Each person costs one primary-key
-- lookup whatever the planner estimates. Uncorrelated IN lists were tried
-- first: under the preview's ORDER BY ... LIMIT 10 Postgres rescanned them
-- for every person and the preview timed out.
--
-- Degraded (summary never built, bad params): an include matches nobody and
-- an exclude excludes nobody, the same rule as email_engagement (016). A
-- person with no email matches neither polarity.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.segments_email_activity (
  email           text PRIMARY KEY,
  last_sent_at    timestamptz,
  last_opened_at  timestamptz,
  last_clicked_at timestamptz,
  last_replied_at timestamptz
);

-- One row recording the last rebuild, so the predicate can tell an empty
-- summary from one that has never been built.
CREATE TABLE IF NOT EXISTS public.segments_email_activity_state (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  refreshed_at  timestamptz,
  row_count     integer,
  duration_ms   integer
);

-- Only the owner (every caller of the compiled SQL is a SECURITY DEFINER
-- function owned by it) and the service role read these.
ALTER TABLE public.segments_email_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.segments_email_activity_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.segments_email_activity, public.segments_email_activity_state FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON public.segments_email_activity, public.segments_email_activity_state FROM anon, authenticated;
  GRANT ALL ON public.segments_email_activity, public.segments_email_activity_state TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- Rebuild from email_send_log and the reply tables. Takes about 30s on AAIF,
-- so only the worker (direct connection, long statement limit) calls it.
CREATE OR REPLACE FUNCTION public.segments_refresh_email_activity()
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = public
AS $$
DECLARE
  v_start  timestamptz := clock_timestamp();
  v_rows   integer;
  v_ms     integer;
  v_tbl    text;
  v_union  text[] := '{}';
BEGIN
  -- One rebuild at a time: a retry or a manual run alongside the cron waits
  -- for nothing and returns.
  IF NOT pg_try_advisory_xact_lock(hashtext('segments_refresh_email_activity')) THEN
    RETURN jsonb_build_object('skipped', 'another refresh is running');
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _seg_activity_new (
    email text PRIMARY KEY, last_sent_at timestamptz, last_opened_at timestamptz,
    last_clicked_at timestamptz, last_replied_at timestamptz
  ) ON COMMIT DROP;
  TRUNCATE _seg_activity_new;

  IF to_regclass('public.email_send_log') IS NOT NULL THEN
    INSERT INTO _seg_activity_new (email, last_sent_at, last_opened_at, last_clicked_at)
    SELECT lower(btrim(recipient_email)), max(sent_at), max(first_opened_at), max(first_clicked_at)
      FROM public.email_send_log
     WHERE recipient_email IS NOT NULL AND btrim(recipient_email) <> ''
     GROUP BY 1;
  END IF;

  FOREACH v_tbl IN ARRAY ARRAY['broadcast_replies', 'newsletter_replies', 'event_replies'] LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      v_union := array_append(v_union, format(
        'SELECT lower(btrim(from_email)) AS email, created_at FROM public.%I WHERE from_email IS NOT NULL AND btrim(from_email) <> '''' AND is_auto_reply IS NOT TRUE',
        v_tbl));
    END IF;
  END LOOP;
  IF cardinality(v_union) > 0 THEN
    EXECUTE format(
      -- Only addresses we have emailed: reply senders are not authenticated,
      -- so a stranger's reply must not add rows or mark another address.
      'UPDATE _seg_activity_new n SET last_replied_at = r.last_replied_at
         FROM (SELECT email, max(created_at) AS last_replied_at FROM (%s) x GROUP BY email) r
        WHERE n.email = r.email',
      array_to_string(v_union, ' UNION ALL '));
  END IF;

  SELECT count(*) INTO v_rows FROM _seg_activity_new;

  -- An empty rebuild over a populated summary means the send log is missing
  -- or unreadable, not that nobody was ever emailed. Keep the old summary:
  -- emptying it would make every "not opened" or "not replied" exclusion
  -- match everyone.
  IF v_rows = 0 AND EXISTS (SELECT 1 FROM public.segments_email_activity) THEN
    RETURN jsonb_build_object('skipped', 'rebuild found no activity; kept the previous summary');
  END IF;
  ANALYZE _seg_activity_new;

  -- Upsert only changed rows, then drop addresses with no activity left.
  INSERT INTO public.segments_email_activity AS a (email, last_sent_at, last_opened_at, last_clicked_at, last_replied_at)
  SELECT email, last_sent_at, last_opened_at, last_clicked_at, last_replied_at FROM _seg_activity_new
  ON CONFLICT (email) DO UPDATE
    SET last_sent_at = EXCLUDED.last_sent_at,
        last_opened_at = EXCLUDED.last_opened_at,
        last_clicked_at = EXCLUDED.last_clicked_at,
        last_replied_at = EXCLUDED.last_replied_at
    WHERE (a.last_sent_at, a.last_opened_at, a.last_clicked_at, a.last_replied_at)
          IS DISTINCT FROM (EXCLUDED.last_sent_at, EXCLUDED.last_opened_at, EXCLUDED.last_clicked_at, EXCLUDED.last_replied_at);
  DELETE FROM public.segments_email_activity a
   WHERE NOT EXISTS (SELECT 1 FROM _seg_activity_new n WHERE n.email = a.email);

  v_ms := (extract(epoch FROM clock_timestamp() - v_start) * 1000)::int;
  INSERT INTO public.segments_email_activity_state (id, refreshed_at, row_count, duration_ms)
  VALUES (true, now(), v_rows, v_ms)
  ON CONFLICT (id) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at, row_count = EXCLUDED.row_count, duration_ms = EXCLUDED.duration_ms;

  RETURN jsonb_build_object('rows', v_rows, 'duration_ms', v_ms);
END;
$$;

-- One person, one primary-key lookup. p_kind is 'engaged' (opened or
-- clicked), 'sent' or 'replied'; p_days NULL means at any time. NULL email
-- returns NULL so the person matches neither polarity.
CREATE OR REPLACE FUNCTION public.segments_email_activity_has(p_email text, p_kind text, p_days integer)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
COST 50
AS $$
DECLARE
  r      public.segments_email_activity%ROWTYPE;
  v_from timestamptz;
BEGIN
  IF p_email IS NULL OR btrim(p_email) = '' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO r FROM public.segments_email_activity WHERE email = lower(btrim(p_email));
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  v_from := CASE WHEN p_days IS NULL THEN '-infinity'::timestamptz ELSE now() - make_interval(days => p_days) END;
  RETURN CASE p_kind
    WHEN 'engaged' THEN COALESCE(r.last_opened_at >= v_from, false) OR COALESCE(r.last_clicked_at >= v_from, false)
    WHEN 'sent'    THEN COALESCE(r.last_sent_at >= v_from, false)
    WHEN 'replied' THEN COALESCE(r.last_replied_at >= v_from, false)
    ELSE NULL
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.segments_email_activity_to_sql(cond jsonb)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_op    text := COALESCE(cond->>'operator', 'opened_or_clicked');
  v_raw   text := NULLIF(btrim(COALESCE(cond->>'within_days', '')), '');
  v_neg   boolean := v_op IN ('not_opened_or_clicked', 'not_sent', 'not_replied');
  v_kind  text;
  v_days  integer;
BEGIN
  v_kind := CASE
    WHEN v_op IN ('opened_or_clicked', 'not_opened_or_clicked') THEN 'engaged'
    WHEN v_op IN ('was_sent', 'not_sent') THEN 'sent'
    WHEN v_op IN ('replied', 'not_replied') THEN 'replied'
  END;
  IF v_kind IS NULL THEN
    RETURN 'false';
  END IF;

  IF v_raw IS NOT NULL THEN
    IF v_raw !~ '^[0-9]{1,4}$' THEN
      RETURN CASE WHEN v_neg THEN 'true' ELSE 'false' END;
    END IF;
    v_days := v_raw::integer;
    IF v_days < 1 OR v_days > 3650 THEN
      RETURN CASE WHEN v_neg THEN 'true' ELSE 'false' END;
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.segments_email_activity_state WHERE refreshed_at IS NOT NULL) THEN
    RETURN CASE WHEN v_neg THEN 'true' ELSE 'false' END;
  END IF;

  RETURN CASE WHEN v_neg THEN 'NOT ' ELSE '' END
    || format('public.segments_email_activity_has(p.email, %L, %s)', v_kind, COALESCE(v_days::text, 'NULL'));
END;
$$;

REVOKE ALL ON FUNCTION public.segments_refresh_email_activity() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.segments_email_activity_has(text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.segments_email_activity_to_sql(jsonb) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.segments_refresh_email_activity() FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.segments_email_activity_has(text, text, integer) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.segments_email_activity_to_sql(jsonb) FROM anon;
  GRANT EXECUTE ON FUNCTION public.segments_refresh_email_activity() TO service_role;
  GRANT EXECUTE ON FUNCTION public.segments_email_activity_has(text, text, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION public.segments_email_activity_to_sql(jsonb) TO authenticated, service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO public.segments_condition_sources (kind, module_id, label, predicate_fn, vocabulary_fn, params_schema, operators, sort_order)
VALUES (
  'email_activity', 'segments', 'Any email activity',
  'segments_email_activity_to_sql', NULL,
  jsonb_build_object(
    'type', 'object',
    'properties', jsonb_build_object(
      'within_days', jsonb_build_object('type', 'number', 'minimum', 1, 'maximum', 3650,
        'description', 'Only count activity in this many days. Leave blank for any time.')
    )
  ),
  ARRAY['opened_or_clicked', 'not_opened_or_clicked', 'was_sent', 'not_sent', 'replied', 'not_replied'],
  21
) ON CONFLICT (kind) DO UPDATE
  SET predicate_fn = EXCLUDED.predicate_fn, vocabulary_fn = EXCLUDED.vocabulary_fn,
      params_schema = EXCLUDED.params_schema, operators = EXCLUDED.operators,
      label = EXCLUDED.label, module_id = EXCLUDED.module_id;
