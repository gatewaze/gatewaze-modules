-- Deterministic seed fixture for newsletter geo/timezone engagement RPCs.
-- Spec §13. Local dev has zero email_interactions (webhook can't reach
-- localhost), so this synthesises a self-contained edition with blocks, links,
-- a send, recipients, delivery log and open/click interactions across several
-- countries / cities / timezones / blocks / poll options — including bots,
-- low-confidence opens, consent-suppressed rows, and a sub-K country — so the
-- RPC behaviour (bot filter, k-anonymity, IP/profile split, tz fallback, option
-- split) is verifiable. Idempotent: re-running re-seeds cleanly.
--
-- NOTE: email_interactions.is_bot is GENERATED AS (human_confidence < 0.3), so
-- the fixture never inserts is_bot; it drives it via human_confidence:
--   click/open human   → conf 0.9–1.0  (is_bot false)
--   MPP/gated open      → conf 0.4      (is_bot false, but below the 0.5 opens gate)
--   bot                 → conf 0.0      (is_bot true)
--
-- Namespace: edition a51a0000-…-0001; recipient emails geofix+<CC>-<n>@example.test.

\set ON_ERROR_STOP on

DO $seed$
DECLARE
  v_edition uuid := 'a51a0000-0000-0000-0000-000000000001';
  v_send    uuid := 'a51a0000-0000-0000-0000-000000000051';
  v_bdef    uuid;  -- reuse an existing block-def (FK to templates_block_defs)
  v_b1      uuid := 'a51a0000-0000-0000-0000-0000000000b1';  -- hot_take
  v_b2      uuid := 'a51a0000-0000-0000-0000-0000000000b2';  -- generic
  v_b3      uuid := 'a51a0000-0000-0000-0000-0000000000b3';  -- podcast
  v_l1      uuid := 'a51a0000-0000-0000-0000-000000000a01';  -- option 1 (Agree)
  v_l2      uuid := 'a51a0000-0000-0000-0000-000000000a02';  -- option 2 (Disagree)
  v_l3      uuid := 'a51a0000-0000-0000-0000-000000000a03';  -- generic link
  v_l4      uuid := 'a51a0000-0000-0000-0000-000000000a04';  -- podcast link
  v_base    timestamptz := '2026-06-10 06:00:00+00';
  r RECORD;
  g int;
  esl uuid;
  v_opt1_clicks int;
  v_local_min int;
BEGIN
  -- ── clean prior fixture ────────────────────────────────────────────────
  DELETE FROM public.email_interactions      WHERE edition_id = v_edition;
  DELETE FROM public.email_send_log          WHERE newsletter_send_id = v_send;
  DELETE FROM public.newsletter_send_recipients WHERE send_id = v_send;
  DELETE FROM public.people                  WHERE email LIKE 'geofix+%@example.test';
  DELETE FROM public.newsletters_edition_links  WHERE edition_id = v_edition;
  DELETE FROM public.newsletters_edition_blocks WHERE edition_id = v_edition;
  DELETE FROM public.newsletter_sends        WHERE id = v_send;
  DELETE FROM public.newsletters_editions    WHERE id = v_edition;

  SELECT id INTO v_bdef FROM public.templates_block_defs ORDER BY id LIMIT 1;
  IF v_bdef IS NULL THEN
    RAISE EXCEPTION 'geo fixture: no templates_block_defs row to reference';
  END IF;

  -- ── edition + send + blocks + links ────────────────────────────────────
  INSERT INTO public.newsletters_editions (id, title, edition_date)
  VALUES (v_edition, 'Geo Fixture Edition', '2026-06-10');

  INSERT INTO public.newsletter_sends (id, edition_id, subject, from_address, status)
  VALUES (v_send, v_edition, 'Geo fixture', 'news@example.test', 'sent');

  INSERT INTO public.newsletters_edition_blocks (id, edition_id, block_type, templates_block_def_id, content, block_order, sort_order)
  VALUES
    (v_b1, v_edition, 'hot_take', v_bdef,
       jsonb_build_object('title','Hot take','poll_option_1_label','Agree','poll_option_2_label','Disagree'), 1, 1),
    (v_b2, v_edition, 'generic',  v_bdef, jsonb_build_object('title','Generic'), 2, 2),
    (v_b3, v_edition, 'podcast',  v_bdef, jsonb_build_object('title','Podcast'), 3, 3);

  INSERT INTO public.newsletters_edition_links
    (id, edition_id, block_id, link_type, link_index, original_url, short_path, short_url, distribution_channel, tracking_key, field, block_type)
  VALUES
    (v_l1, v_edition, v_b1, 'poll_option_1', 0, 'https://go.example.com/agree',    'agr', '', 'email', 'geofixagr01', 'poll_option_1_link', 'hot_take'),
    (v_l2, v_edition, v_b1, 'poll_option_2', 1, 'https://go.example.com/disagree', 'dis', '', 'email', 'geofixdis01', 'poll_option_2_link', 'hot_take'),
    (v_l3, v_edition, v_b2, 'generic',       0, 'https://example.com/article',     'art', '', 'email', 'geofixart01', 'link',              'generic'),
    (v_l4, v_edition, v_b3, 'podcast',       0, 'https://example.com/podcast',     'pod', '', 'email', 'geofixpod01', 'link',              'podcast');

  -- ── per-country cohorts ────────────────────────────────────────────────
  -- delivered/clickers/openers per country; opt1_pct = % of clickers choosing
  -- option 1 (varies by country → regional opinion split); tz drives the
  -- local-time heatmap; NZ is below K=15 → must be suppressed; 'ZZ' carries an
  -- invalid timezone → tz_fallback.
  FOR r IN
    SELECT * FROM (VALUES
      --  cc , city        , tz                  , delivered, clickers, openers, opt1_pct
      ('US','New York'     ,'America/New_York'   , 60, 30, 48, 70),
      ('GB','London'       ,'Europe/London'      , 40, 20, 30, 45),
      ('IN','Bengaluru'    ,'Asia/Kolkata'       , 30, 16, 22, 60),
      ('DE','Berlin'       ,'Europe/Berlin'      , 22,  9, 14, 30),  -- sub-K for R4 options
      ('AU','Sydney'       ,'Australia/Sydney'   , 16,  7, 10, 55),  -- sub-K for R4 options
      ('NZ','Auckland'     ,'Pacific/Auckland'   ,  6,  4,  5, 50),  -- sub-K everywhere
      ('ZZ','Nowhere'      ,'Not/AZone'          , 16,  6,  9, 50)   -- invalid tz → fallback
    ) AS t(cc, city, tz, delivered, clickers, openers, opt1_pct)
  LOOP
    v_opt1_clicks := round(r.clickers * r.opt1_pct / 100.0);
    FOR g IN 1..r.delivered LOOP
      INSERT INTO public.people (id, email, attributes)
      VALUES (
        md5('geoperson'||r.cc||g)::uuid,
        'geofix+'||r.cc||'-'||g||'@example.test',
        jsonb_build_object('country', r.cc, 'city', r.city, 'timezone', r.tz, 'email','geofix+'||r.cc||'-'||g||'@example.test')
      );
      esl := md5('geoesl'||r.cc||g)::uuid;
      INSERT INTO public.email_send_log (id, recipient_email, newsletter_send_id, status, delivered_at, sent_at)
      VALUES (esl, 'geofix+'||r.cc||'-'||g||'@example.test', v_send, 'delivered', v_base, v_base);
      INSERT INTO public.newsletter_send_recipients (id, send_id, person_id, email, timezone, send_at, status, strategy)
      VALUES (md5('geosr'||r.cc||g)::uuid, v_send, md5('geoperson'||r.cc||g)::uuid,
              'geofix+'||r.cc||'-'||g||'@example.test', r.tz, v_base, 'sent', 'tz_local');

      v_local_min := (g * 37) % (24*60);

      -- CLICK on hot_take option (first v_clickers recipients click)
      IF g <= r.clickers THEN
        INSERT INTO public.email_interactions
          (id, email_send_log_id, event_type, event_timestamp, clicked_url, ip_geo_country,
           human_confidence, edition_link_id, block_id, block_type, edition_id, consent_suppressed)
        VALUES (
          md5('geoclk'||r.cc||g)::uuid, esl, 'click',
          v_base + make_interval(mins => v_local_min),
          'https://go.example.com/x', r.cc, 1.0,
          CASE WHEN g <= v_opt1_clicks THEN v_l1 ELSE v_l2 END,
          v_b1, 'hot_take', v_edition, false
        );
        IF g % 3 = 0 THEN
          INSERT INTO public.email_interactions
            (id, email_send_log_id, event_type, event_timestamp, clicked_url, ip_geo_country,
             human_confidence, edition_link_id, block_id, block_type, edition_id, consent_suppressed)
          VALUES (md5('geoclkg'||r.cc||g)::uuid, esl, 'click',
            v_base + make_interval(mins => v_local_min), 'https://example.com/article', r.cc,
            1.0, v_l3, v_b2, 'generic', v_edition, false);
        END IF;
        IF g % 5 = 0 THEN
          INSERT INTO public.email_interactions
            (id, email_send_log_id, event_type, event_timestamp, clicked_url, ip_geo_country,
             human_confidence, edition_link_id, block_id, block_type, edition_id, consent_suppressed)
          VALUES (md5('geoclkp'||r.cc||g)::uuid, esl, 'click',
            v_base + make_interval(mins => v_local_min), 'https://example.com/podcast', r.cc,
            1.0, v_l4, v_b3, 'podcast', v_edition, false);
        END IF;
      END IF;

      -- OPEN (first v_openers recipients open; human, conf 0.9)
      IF g <= r.openers THEN
        INSERT INTO public.email_interactions
          (id, email_send_log_id, event_type, event_timestamp, ip_geo_country,
           human_confidence, block_id, block_type, edition_id, consent_suppressed)
        VALUES (md5('geoopn'||r.cc||g)::uuid, esl, 'open',
          v_base + make_interval(mins => v_local_min), r.cc, 0.9,
          NULL, NULL, v_edition, false);
      END IF;
    END LOOP;
  END LOOP;

  -- ── noise rows that MUST be excluded ──────────────────────────────────
  -- carrier delivery-log row for the noise interactions; NOT delivered (bounced)
  -- so it never enters the delivered/denominator/tz sets — only its interactions
  -- (which are themselves excluded by the bot/gate/consent filters) hang off it.
  INSERT INTO public.email_send_log (id, recipient_email, newsletter_send_id, status, delivered_at, sent_at)
  VALUES (md5('geobotesl')::uuid, 'geofix+US-bot@example.test', v_send, 'bounced', NULL, v_base);
  -- bot click (conf 0.0 → is_bot true) — excluded from every metric
  INSERT INTO public.email_interactions
    (id, email_send_log_id, event_type, event_timestamp, clicked_url, ip_geo_country, human_confidence,
     edition_link_id, block_id, block_type, edition_id, consent_suppressed)
  VALUES (md5('geobotclk')::uuid, md5('geobotesl')::uuid, 'click', v_base, 'https://go.example.com/x', 'US', 0.0,
          v_l1, v_b1, 'hot_take', v_edition, false);
  -- gated open (conf 0.4 → is_bot false, but < 0.5 opens gate) — excluded from opens
  INSERT INTO public.email_interactions
    (id, email_send_log_id, event_type, event_timestamp, ip_geo_country, human_confidence,
     block_id, block_type, edition_id, consent_suppressed)
  VALUES (md5('geomppopen')::uuid, md5('geobotesl')::uuid, 'open', v_base, 'US', 0.4,
          NULL, NULL, v_edition, false);
  -- consent-suppressed click — excluded everywhere
  INSERT INTO public.email_interactions
    (id, email_send_log_id, event_type, event_timestamp, clicked_url, ip_geo_country, human_confidence,
     edition_link_id, block_id, block_type, edition_id, consent_suppressed)
  VALUES (md5('geoconsent')::uuid, md5('geobotesl')::uuid, 'click', v_base, 'https://go.example.com/x', 'US', 1.0,
          v_l1, v_b1, 'hot_take', v_edition, true);

  -- ── send-log-only edition (imported/historical engagement) ────────────
  -- Mirrors the production case: aggregate first_opened_at/first_clicked_at on
  -- email_send_log, NO email_interactions. The geo RPCs must fall back to the
  -- send-log timestamps + profile geo. Edition a51a…0002.
  DECLARE
    v_ed2  uuid := 'a51a0000-0000-0000-0000-000000000002';
    v_snd2 uuid := 'a51a0000-0000-0000-0000-000000000052';
    e2 RECORD; gg int; pe text;
  BEGIN
    DELETE FROM public.email_send_log WHERE newsletter_send_id = v_snd2;
    DELETE FROM public.people WHERE email LIKE 'geofix2+%@example.test';
    DELETE FROM public.newsletter_sends WHERE id = v_snd2;
    DELETE FROM public.newsletters_editions WHERE id = v_ed2;

    INSERT INTO public.newsletters_editions (id, title, edition_date)
    VALUES (v_ed2, 'Geo Fixture (imported)', '2026-06-11');
    INSERT INTO public.newsletter_sends (id, edition_id, subject, from_address, status)
    VALUES (v_snd2, v_ed2, 'Imported', 'news@example.test', 'sent');

    FOR e2 IN
      SELECT * FROM (VALUES
        ('US','America/New_York', 40, 30),
        ('GB','Europe/London',    25, 12),
        ('NZ','Pacific/Auckland',  6,  3)   -- sub-K, suppressed
      ) AS t(cc, tz, delivered, openers)
    LOOP
      FOR gg IN 1..e2.delivered LOOP
        pe := 'geofix2+'||e2.cc||'-'||gg||'@example.test';
        INSERT INTO public.people (id, email, attributes)
        VALUES (md5('geofix2P'||e2.cc||gg)::uuid, pe,
          jsonb_build_object('country', e2.cc, 'timezone', e2.tz, 'email', pe));
        -- delivered; openers also carry first_opened_at (no interaction rows)
        INSERT INTO public.email_send_log
          (id, recipient_email, newsletter_send_id, status, delivered_at, sent_at, first_opened_at)
        VALUES (md5('geofix2E'||e2.cc||gg)::uuid, pe, v_snd2, 'delivered', v_base, v_base,
          CASE WHEN gg <= e2.openers THEN v_base + make_interval(mins => (gg*53) % (24*60)) END);
      END LOOP;
    END LOOP;
  END;

  RAISE NOTICE 'geo fixture seeded for editions % and a51a…0002', v_edition;
END;
$seed$;
