-- LOCAL DEMO seed: populates the geo-engagement reports for a real, navigable
-- mlopscommunity edition so the Geography tab shows live data on aaif localhost.
-- NOT a test fixture (that's geo_engagement_fixture.sql) — this targets a real
-- edition and is additive + namespaced (emails geodemo+…@example.test). Idempotent.
--
-- Target edition (mlopscommunity / 3d76125b) renders today; we attribute R3
-- clicks to its REAL blocks and add one demo HotTake block (+2 option links) so
-- R4 (the per-option regional split) also has data. Safe to delete later.
\set ON_ERROR_STOP on

DO $demo$
DECLARE
  v_edition uuid := '3d76125b-97e2-45aa-a693-bab24d242743';
  v_send    uuid := 'a51a0000-0000-0000-0000-0000000005d1';
  v_hot     uuid := 'a51a0000-0000-0000-0000-0000000000d1';  -- demo hot_take
  v_l1      uuid := 'a51a0000-0000-0000-0000-000000000d01';  -- option Agree
  v_l2      uuid := 'a51a0000-0000-0000-0000-000000000d02';  -- option Disagree
  v_bdef    uuid;
  v_real    uuid[];
  v_base    timestamptz := '2026-06-16 06:00:00+00';
  r RECORD; g int; esl uuid; v_opt1 int; v_min int; v_blk uuid;
BEGIN
  -- reuse a real block-def from this edition (valid FK) for the demo hot_take
  SELECT templates_block_def_id INTO v_bdef FROM public.newsletters_edition_blocks
    WHERE edition_id = v_edition ORDER BY sort_order LIMIT 1;
  SELECT array_agg(id ORDER BY sort_order) INTO v_real FROM public.newsletters_edition_blocks
    WHERE edition_id = v_edition AND id <> v_hot;

  -- clean prior demo
  DELETE FROM public.email_interactions WHERE edition_id = v_edition
    AND email_send_log_id IN (SELECT id FROM public.email_send_log WHERE newsletter_send_id = v_send);
  DELETE FROM public.email_send_log WHERE newsletter_send_id = v_send;
  DELETE FROM public.newsletter_send_recipients WHERE send_id = v_send;
  DELETE FROM public.people WHERE email LIKE 'geodemo+%@example.test';
  DELETE FROM public.newsletters_edition_links WHERE id IN (v_l1, v_l2);
  DELETE FROM public.newsletters_edition_blocks WHERE id = v_hot;
  DELETE FROM public.newsletter_sends WHERE id = v_send;

  INSERT INTO public.newsletter_sends (id, edition_id, subject, from_address, status)
  VALUES (v_send, v_edition, 'Geo demo', 'news@example.test', 'sent');

  -- demo hot_take block + its two option links (enables R4 with real labels)
  INSERT INTO public.newsletters_edition_blocks (id, edition_id, block_type, templates_block_def_id, content, block_order, sort_order)
  VALUES (v_hot, v_edition, 'hot_take', v_bdef,
    jsonb_build_object('title','Hot take of the week','poll_option_1_label','Agree','poll_option_2_label','Disagree'), 99, 99);
  INSERT INTO public.newsletters_edition_links
    (id, edition_id, block_id, link_type, link_index, original_url, short_path, short_url, distribution_channel)
  VALUES
    (v_l1, v_edition, v_hot, 'poll_option_1', 0, 'https://go.mlops.community/agree',    'agr', '', 'email'),
    (v_l2, v_edition, v_hot, 'poll_option_2', 1, 'https://go.mlops.community/disagree', 'dis', '', 'email');

  FOR r IN
    SELECT * FROM (VALUES
      ('US','New York'  ,'America/New_York' , 60, 30, 48, 70),
      ('GB','London'    ,'Europe/London'    , 40, 20, 30, 45),
      ('IN','Bengaluru' ,'Asia/Kolkata'     , 30, 16, 22, 60),
      ('DE','Berlin'    ,'Europe/Berlin'    , 22,  9, 14, 30),
      ('AU','Sydney'    ,'Australia/Sydney' , 16,  7, 10, 55),
      ('CA','Toronto'   ,'America/Toronto'  , 20, 10, 15, 65),
      ('FR','Paris'     ,'Europe/Paris'     , 18,  8, 12, 40),
      ('BR','Sao Paulo' ,'America/Sao_Paulo', 17,  9, 12, 50),
      ('NZ','Auckland'  ,'Pacific/Auckland' ,  6,  4,  5, 50)
    ) AS t(cc, city, tz, delivered, clickers, openers, opt1_pct)
  LOOP
    v_opt1 := round(r.clickers * r.opt1_pct / 100.0);
    FOR g IN 1..r.delivered LOOP
      INSERT INTO public.people (id, email, attributes)
      VALUES (md5('geodemoP'||r.cc||g)::uuid, 'geodemo+'||r.cc||'-'||g||'@example.test',
        jsonb_build_object('country',r.cc,'city',r.city,'timezone',r.tz,'email','geodemo+'||r.cc||'-'||g||'@example.test'));
      esl := md5('geodemoE'||r.cc||g)::uuid;
      INSERT INTO public.email_send_log (id, recipient_email, newsletter_send_id, status, delivered_at, sent_at)
      VALUES (esl, 'geodemo+'||r.cc||'-'||g||'@example.test', v_send, 'delivered', v_base, v_base);
      INSERT INTO public.newsletter_send_recipients (id, send_id, person_id, email, timezone, send_at, status, strategy)
      VALUES (md5('geodemoR'||r.cc||g)::uuid, v_send, md5('geodemoP'||r.cc||g)::uuid,
        'geodemo+'||r.cc||'-'||g||'@example.test', r.tz, v_base, 'sent', 'tz_local');
      v_min := (g * 37) % (24*60);

      IF g <= r.clickers THEN
        -- vote on the demo hot_take (R4)
        INSERT INTO public.email_interactions
          (id, email_send_log_id, event_type, event_timestamp, clicked_url, ip_geo_country, human_confidence,
           edition_link_id, block_id, block_type, edition_id, consent_suppressed)
        VALUES (md5('geodemoCv'||r.cc||g)::uuid, esl, 'click', v_base + make_interval(mins => v_min),
          'https://go.mlops.community/x', r.cc, 1.0,
          CASE WHEN g <= v_opt1 THEN v_l1 ELSE v_l2 END, v_hot, 'hot_take', v_edition, false);
        -- click on a real block of this edition (R3), cycling through them
        v_blk := v_real[1 + (g % array_length(v_real,1))];
        INSERT INTO public.email_interactions
          (id, email_send_log_id, event_type, event_timestamp, clicked_url, ip_geo_country, human_confidence,
           block_id, block_type, edition_id, consent_suppressed)
        VALUES (md5('geodemoCb'||r.cc||g)::uuid, esl, 'click', v_base + make_interval(mins => v_min),
          'https://example.com/b', r.cc, 1.0, v_blk,
          (SELECT block_type FROM public.newsletters_edition_blocks WHERE id = v_blk), v_edition, false);
      END IF;

      IF g <= r.openers THEN
        INSERT INTO public.email_interactions
          (id, email_send_log_id, event_type, event_timestamp, ip_geo_country, human_confidence,
           block_id, block_type, edition_id, consent_suppressed)
        VALUES (md5('geodemoO'||r.cc||g)::uuid, esl, 'open', v_base + make_interval(mins => v_min),
          r.cc, 0.9, NULL, NULL, v_edition, false);
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'geo DEMO seeded onto edition % (open its Geography tab)', v_edition;
END;
$demo$;
