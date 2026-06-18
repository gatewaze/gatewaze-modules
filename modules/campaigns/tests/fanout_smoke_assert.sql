\set ON_ERROR_STOP on
-- Seed people in different timezones
INSERT INTO public.people (id, email, attributes) VALUES
  ('11111111-1111-1111-1111-111111111111','alice@example.com','{"first_name":"Alice","timezone":"America/New_York"}'),
  ('22222222-2222-2222-2222-222222222222','bob@example.com','{"first_name":"Bob","timezone":"Europe/London"}'),
  ('33333333-3333-3333-3333-333333333333','carol@example.com','{"first_name":"Carol"}'),         -- no tz → default
  ('44444444-4444-4444-4444-444444444444','dave@example.com','{"first_name":"Dave","timezone":"America/Los_Angeles"}'); -- will be suppressed

-- Segment + memberships (all four)
INSERT INTO public.segments (id, name, last_calculated_at) VALUES ('99999999-9999-9999-9999-999999999999','NY+others', now());
INSERT INTO public.segments_memberships (segment_id, person_id) VALUES
  ('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111'),
  ('99999999-9999-9999-9999-999999999999','22222222-2222-2222-2222-222222222222'),
  ('99999999-9999-9999-9999-999999999999','33333333-3333-3333-3333-333333333333'),
  ('99999999-9999-9999-9999-999999999999','44444444-4444-4444-4444-444444444444');

-- Dave unsubscribed from the 'campaigns' topic → must be excluded
INSERT INTO public.campaign_suppressions (email, topic, source) VALUES ('dave@example.com','campaigns','manual');

-- A tz_local campaign send at 09:00, default UTC
INSERT INTO public.campaign_sends (id, name, brand, audience_type, segment_id, subject, rendered_html, suppression_topic, status, delivery_strategy, default_timezone, target_local, scheduled_at)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Test','aaif','segment','99999999-9999-9999-9999-999999999999','Hi','<html><body>Hello</body></html>','campaigns','scheduled','tz_local','UTC','09:00','2026-06-19 00:00:00+00');

-- FAN OUT
SELECT public.fanout_campaign_send_recipients('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') AS fanned_out;

\echo '--- recipients (Dave excluded; per-tz send_at) ---'
SELECT email, timezone, send_at FROM public.campaign_send_recipients ORDER BY email;

\echo '--- total_recipients on send (expect 3) ---'
SELECT total_recipients FROM public.campaign_sends WHERE id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

\echo '--- claim due (none yet: send_at is 09:00 future, status scheduled not sending) ---'
SELECT count(*) AS claimed_when_scheduled FROM public.claim_due_campaign_recipients(500);

\echo '--- flip to sending + backdate send_at, then claim ---'
UPDATE public.campaign_sends SET status='sending' WHERE id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
UPDATE public.campaign_send_recipients SET send_at = now() - interval '1 minute';
SELECT count(*) AS claimed_now FROM public.claim_due_campaign_recipients(500);

\echo '--- timezone breakdown ---'
SELECT timezone, recipients FROM public.campaign_send_timezone_breakdown('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') ORDER BY timezone;

\echo '--- event_filters SQL generation: attended event in San Francisco ---'
SELECT public.segments_event_to_sql('{"type":"event","event_type":"event_attended","operator":"performed","event_filters":[{"property":"event_city","operator":"equals","value":"San Francisco"}]}'::jsonb) AS sql;

\echo '--- idempotent re-fanout (expect 0 new) ---'
SELECT public.fanout_campaign_send_recipients('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') AS refanned;
