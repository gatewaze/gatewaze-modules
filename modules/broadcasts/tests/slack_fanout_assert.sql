-- Slack broadcast fan-out, claims, count, grants and RLS (migration 032).
-- Seeds throwaway rows and asserts; run it inside a transaction that is
-- rolled back, as the table owner, after 032 has been applied:
--   { printf '%s\n' 'BEGIN;'; cat tests/slack_fanout_assert.sql; printf '%s\n' 'ROLLBACK;'; } |
--     psql -v ON_ERROR_STOP=1 -U supabase_admin
-- Runs after migration 032 inside the caller's transaction.
DO $$
DECLARE
  seg uuid; prev uuid; s uuid; es uuid; n int; r record; after text; guard int := 0;
  p uuid[] := ARRAY[]::uuid[];
BEGIN
  INSERT INTO segments (name) VALUES ('zz slack test') RETURNING id INTO seg;
  -- p1..p8 (see comments in the test plan)
  WITH ins AS (
    INSERT INTO people (email, contact_kind, attributes) VALUES
      ('zz-a1@slacktest.io', 'member',   '{"slack_user_id":"U0001AAA","first_name":"A"}'),
      ('zz-a2@slacktest.io', 'prospect', '{"slack_user_id":"U0002BBB"}'),
      ('zz-a3@slacktest.io', 'member',   '{"slack_user_id":"U0003CCC"}'),
      ('zz-a4@slacktest.io', 'member',   '{}'),
      ('zz-a5@slacktest.io', 'member',   '{"slack_user_id":" U0001AAA "}'),
      ('zz-a6@slacktest.io', 'member',   '{"slack_user_id":"bogus"}'),
      ('zz-a7@slacktest.io', 'member',   '{"slack_user_id":"U0007GGG"}'),
      ('zz-a8@slacktest.io', 'member',   '{"slack_user_id":"U0008HHH"}')
    RETURNING id, email)
  INSERT INTO segments_memberships (segment_id, person_id) SELECT seg, id FROM ins;
  INSERT INTO broadcast_suppressions (email, topic, source) VALUES ('zz-a3@slacktest.io', 'slack', 'test'), ('zz-a7@slacktest.io', 'all', 'test');

  -- An earlier Slack send that reached a8.
  INSERT INTO broadcast_sends (name, channel, segment_id, status, suppression_topic) VALUES ('zz prev', 'slack', seg, 'sent', 'slack') RETURNING id INTO prev;
  INSERT INTO broadcast_send_recipients (send_id, email, slack_user_id, send_at, status) VALUES (prev, 'zz-a8@slacktest.io', 'U0008HHH', now(), 'sent');

  -- Slack send with no preheader: allowed.
  INSERT INTO broadcast_sends (name, channel, segment_id, status, suppression_topic, body_text, exclude_sent_send_ids)
    VALUES ('zz slack', 'slack', seg, 'scheduled', 'slack', 'Hi {{first_name}}', ARRAY[prev]) RETURNING id INTO s;

  -- Email send with no preheader: still refused.
  BEGIN
    INSERT INTO broadcast_sends (name, channel, segment_id, status) VALUES ('zz email no preheader', 'email', seg, 'draft');
    RAISE EXCEPTION 'email send without preheader was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Page through like the dispatcher, two people per page, so the duplicate
  -- Slack ID (a1 / a5) lands on a different page.
  LOOP
    SELECT * INTO r FROM fanout_broadcast_send_recipients_batch(s, 2, after);
    after := COALESCE(r.last_email, after);
    EXIT WHEN NOT r.remaining;
    guard := guard + 1; IF guard > 20 THEN RAISE EXCEPTION 'paging did not end'; END IF;
  END LOOP;
  SELECT count(*) INTO n FROM broadcast_send_recipients WHERE send_id = s;
  RAISE NOTICE 'slack recipients: %', (SELECT string_agg(email || '=' || slack_user_id, ', ' ORDER BY email) FROM broadcast_send_recipients WHERE send_id = s);
  ASSERT n = 1, format('expected 1 Slack recipient, got %s', n);
  ASSERT EXISTS (SELECT 1 FROM broadcast_send_recipients WHERE send_id = s AND email = 'zz-a1@slacktest.io' AND slack_user_id = 'U0001AAA'), 'a1 missing (or ID not trimmed)';
  ASSERT NOT EXISTS (SELECT 1 FROM broadcast_send_recipients WHERE send_id = s AND email = 'zz-a7@slacktest.io'), 'a7 opted out of everything but got Slack';

  -- One page holding both people linked to U0001AAA: still one message.
  DECLARE s2 uuid; BEGIN
    INSERT INTO broadcast_sends (name, channel, segment_id, status, suppression_topic, body_text)
      VALUES ('zz slack one page', 'slack', seg, 'scheduled', 'slack', 'Hi') RETURNING id INTO s2;
    PERFORM fanout_broadcast_send_recipients_batch(s2, 5000, NULL);
    SELECT count(*) INTO n FROM broadcast_send_recipients WHERE send_id = s2 AND slack_user_id = 'U0001AAA';
    ASSERT n = 1, format('same-page duplicate Slack ID gave %s rows', n);
    DELETE FROM broadcast_sends WHERE id = s2;
  END;

  -- Fan-out again: idempotent.
  PERFORM fanout_broadcast_send_recipients_batch(s, 5000, NULL);
  SELECT count(*) INTO n FROM broadcast_send_recipients WHERE send_id = s;
  ASSERT n = 1, 'second fan-out added rows';

  -- Including prospects adds a2.
  UPDATE broadcast_sends SET include_prospects = true WHERE id = s;
  PERFORM fanout_broadcast_send_recipients_batch(s, 5000, NULL);
  SELECT count(*) INTO n FROM broadcast_send_recipients WHERE send_id = s;
  ASSERT n = 2, format('expected a2 added with prospects included, got %s', n);
  UPDATE broadcast_sends SET include_prospects = false WHERE id = s;

  -- Email send on the same segment: email rules unchanged (a4 with no Slack
  -- is in; a7 unsubscribed from all email and a2 the prospect are out).
  INSERT INTO broadcast_sends (name, channel, segment_id, status, preheader) VALUES ('zz email', 'email', seg, 'scheduled', 'pre') RETURNING id INTO es;
  PERFORM fanout_broadcast_send_recipients_batch(es, 5000, NULL);
  ASSERT EXISTS (SELECT 1 FROM broadcast_send_recipients WHERE send_id = es AND email = 'zz-a4@slacktest.io'), 'email fan-out lost a4';
  ASSERT NOT EXISTS (SELECT 1 FROM broadcast_send_recipients WHERE send_id = es AND email IN ('zz-a7@slacktest.io', 'zz-a2@slacktest.io')), 'email fan-out ignored suppression/prospect';
  ASSERT NOT EXISTS (SELECT 1 FROM broadcast_send_recipients WHERE send_id = es AND slack_user_id IS NOT NULL), 'email rows got a slack id';

  -- Claims split by channel.
  UPDATE broadcast_sends SET status = 'sending' WHERE id IN (s, es);
  SELECT count(*) INTO n FROM claim_due_broadcast_slack_recipients(100) c WHERE c.send_id IN (s, es);
  ASSERT n = 2, format('slack claim got %s', n);
  ASSERT NOT EXISTS (SELECT 1 FROM broadcast_send_recipients WHERE send_id = es AND status = 'sending'), 'slack claim took email rows';
  SELECT count(*) INTO n FROM claim_due_broadcast_recipients(1000) c WHERE c.send_id = s;
  ASSERT n = 0, 'email claim took slack rows';
  ASSERT EXISTS (SELECT 1 FROM broadcast_send_recipients WHERE send_id = es AND status = 'sending'), 'email claim missed email rows';

  RAISE NOTICE 'seg=%', seg;
  PERFORM set_config('zz.seg', seg::text, true);
  PERFORM set_config('zz.prev', prev::text, true);
END $$;

-- Preview count: service role allowed; mirrors the fan-out filters.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
DO $$
DECLARE n int; seg uuid := current_setting('zz.seg')::uuid; prev uuid := current_setting('zz.prev')::uuid;
BEGIN
  n := broadcast_slack_recipient_preview_count(seg, NULL, false);
  ASSERT n = 2, format('count without exclusions %s', n);      -- U0001AAA, U0008HHH
  n := broadcast_slack_recipient_preview_count(seg, ARRAY[prev], false);
  ASSERT n = 1, format('count excluding prev %s', n);
  n := broadcast_slack_recipient_preview_count(seg, ARRAY[prev], true);
  ASSERT n = 2, format('count with prospects %s', n);
END $$;

-- A signed-in non-admin is refused.
SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000dead"}', true);
DO $$
BEGIN
  PERFORM broadcast_slack_recipient_preview_count(current_setting('zz.seg')::uuid, NULL, false);
  RAISE EXCEPTION 'non-admin was allowed to count';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;

-- Grants.
DO $$
BEGIN
  ASSERT NOT has_function_privilege('authenticated', 'public.claim_due_broadcast_slack_recipients(integer)', 'EXECUTE'), 'authenticated can claim slack rows';
  ASSERT NOT has_function_privilege('anon', 'public.fanout_broadcast_slack_recipients_batch(uuid, integer, text)', 'EXECUTE'), 'anon can fan out';
  ASSERT NOT has_function_privilege('anon', 'public.broadcast_slack_recipient_preview_count(uuid, uuid[], boolean)', 'EXECUTE'), 'anon can count';
END $$;

-- RLS: a signed-in non-admin sees and writes nothing.
SET LOCAL ROLE authenticated;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM broadcast_sends; ASSERT n = 0, 'non-admin can read broadcast_sends';
  SELECT count(*) INTO n FROM broadcast_send_recipients; ASSERT n = 0, 'non-admin can read recipients';
  SELECT count(*) INTO n FROM broadcast_suppressions; ASSERT n = 0, 'non-admin can read suppressions';
  BEGIN
    INSERT INTO broadcast_sends (name, channel, status, suppression_topic) VALUES ('zz forged', 'slack', 'sending', 'slack');
    RAISE EXCEPTION 'non-admin inserted a send';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO broadcast_send_batches (send_id, recipient_count, status) VALUES (gen_random_uuid(), 1, 'posting');
    RAISE EXCEPTION 'non-admin inserted a batch';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM fanout_broadcast_send_recipients_batch(gen_random_uuid(), 1, NULL);
    RAISE EXCEPTION 'non-admin could call the fan-out';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

SELECT 'ALL SQL ASSERTIONS PASSED' AS result;
