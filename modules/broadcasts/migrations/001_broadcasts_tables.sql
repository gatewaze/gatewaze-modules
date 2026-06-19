-- ============================================================================
-- Module: broadcasts
-- Migration: 001_broadcasts_tables
-- Description: Core tables for sending a single scheduled, timezone-aware email
-- to a segment (or contact list). Mirrors the proven newsletter send schema
-- (newsletter_sends / newsletter_send_recipients) so broadcasts ride the SAME
-- per-recipient timezone drip; only the recipient SOURCE differs (segments).
--
-- See spec-broadcasts-module.md §1.1 / §1.5.
-- ============================================================================

-- 1. The broadcast send (one row per send job) -------------------------------
CREATE TABLE IF NOT EXISTS public.broadcast_sends (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,                         -- internal label
  -- Shared-quota + reputation key. broadcasts and newsletters draw from the
  -- same per-brand SendGrid daily cap / IP reputation pool, so the brand must
  -- be on the send (spec §1.5). Resolved from the admin's active brand context.
  brand                 text NOT NULL DEFAULT 'default',
  channel               text NOT NULL DEFAULT 'email'
                        CHECK (channel IN ('email')),          -- widened in Phase 4 (sms/whatsapp/in-app)

  -- Audience source (polymorphic; segment is the headline case).
  audience_type         text NOT NULL DEFAULT 'segment'
                        CHECK (audience_type IN ('segment', 'list')),
  segment_id            uuid REFERENCES public.segments(id),   -- when audience_type='segment'
  list_ids              text[] NOT NULL DEFAULT '{}',          -- when audience_type='list' (text[] matches list_subscriptions convention)

  -- Content (channel=email). Composed in admin, stored rendered for fidelity.
  subject               text,
  preheader             text,
  from_address          text,
  from_name             text,
  reply_to              text,
  rendered_html         text,                                  -- FINAL link-tagged HTML (produced by composer before storage)
  body_text             text,                                  -- short-form body (future SMS/WhatsApp reuse)
  content_json          jsonb NOT NULL DEFAULT '{}'::jsonb,    -- composer source of truth
  suppression_topic     text NOT NULL DEFAULT 'broadcasts',     -- unsubscribe/consent target (spec §1.5)

  -- Scheduling / delivery (identical semantics to newsletter_sends).
  status                text NOT NULL DEFAULT 'draft'
                        CHECK (status = ANY (ARRAY['draft','scheduled','sending','sent','cancelling','cancelled','failed','paused']::text[])),
  schedule_type         text NOT NULL DEFAULT 'immediate'
                        CHECK (schedule_type IN ('immediate', 'scheduled')),
  delivery_strategy     text NOT NULL DEFAULT 'global'
                        CHECK (delivery_strategy IN ('global', 'tz_local', 'personalised')),
  default_timezone      text,                                  -- collection-level fallback IANA tz
  target_local          text,                                  -- 'HH:MM' wall-clock for tz_local
  lead_minutes          integer NOT NULL DEFAULT 45,
  scheduled_at          timestamptz,
  started_at            timestamptz,
  completed_at          timestamptz,
  exclude_sent_send_ids uuid[],                                -- exclude recipients already sent in prior broadcast sends

  total_recipients      integer NOT NULL DEFAULT 0,
  sent_count            integer NOT NULL DEFAULT 0,
  failed_count          integer NOT NULL DEFAULT 0,

  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_broadcast_sends_status_scheduled
  ON public.broadcast_sends(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_broadcast_sends_brand ON public.broadcast_sends(brand);

-- 2. Per-recipient timing queue (generic queue row; clone of
--    newsletter_send_recipients) ------------------------------------------
CREATE TABLE IF NOT EXISTS public.broadcast_send_recipients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id     uuid NOT NULL REFERENCES public.broadcast_sends(id) ON DELETE CASCADE,
  person_id   uuid,
  email       text NOT NULL,
  send_at     timestamptz NOT NULL,                            -- UTC instant to dispatch
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  strategy    text NOT NULL DEFAULT 'global'
              CHECK (strategy IN ('global', 'tz_local', 'personalised')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  timezone    text,                                            -- resolved IANA zone at fan-out
  batch_id    uuid,                                            -- → future broadcast_send_batches (Tier 2)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz,
  CONSTRAINT uq_bsr_send_email UNIQUE (send_id, email)
);

CREATE INDEX IF NOT EXISTS idx_bsr_due ON public.broadcast_send_recipients(status, send_at);
CREATE INDEX IF NOT EXISTS idx_bsr_send ON public.broadcast_send_recipients(send_id);

CREATE TRIGGER broadcast_sends_updated_at
  BEFORE UPDATE ON public.broadcast_sends
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER broadcast_send_recipients_updated_at
  BEFORE UPDATE ON public.broadcast_send_recipients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. Suppression / unsubscribe state (topic-scoped). A segment is an audience
--    DEFINITION, not a consent record — fan-out filters against this so an
--    unsubscribed/suppressed person is never emailed even if they match the
--    segment (spec §1.2 / §1.5). topic='all' is the global opt-out.
CREATE TABLE IF NOT EXISTS public.broadcast_suppressions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  topic       text NOT NULL DEFAULT 'all',                     -- 'all' = global, else a suppression_topic
  brand       text,
  reason      text,
  source      text,                                            -- 'one_click_unsubscribe' | 'manual' | 'bounce' | 'import'
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_broadcast_suppressions_email_topic
  ON public.broadcast_suppressions (lower(email), topic);
CREATE INDEX IF NOT EXISTS idx_broadcast_suppressions_email
  ON public.broadcast_suppressions (lower(email));

-- 4. Attribute email_send_log lifecycle rows to a broadcast send. Additive +
--    idempotent; the column lives on the bulk-emailing-owned table but is safe
--    to add from here (broadcasts depends on bulk-emailing).
ALTER TABLE public.email_send_log
  ADD COLUMN IF NOT EXISTS broadcast_send_id uuid;
CREATE INDEX IF NOT EXISTS idx_esl_broadcast_send
  ON public.email_send_log(broadcast_send_id) WHERE broadcast_send_id IS NOT NULL;

-- 5. RLS: admin / service-role only (these tables hold recipient emails). -----
ALTER TABLE public.broadcast_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_send_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_suppressions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'broadcast_sends' AND policyname = 'auth_all_broadcast_sends') THEN
    CREATE POLICY "auth_all_broadcast_sends" ON public.broadcast_sends FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'broadcast_send_recipients' AND policyname = 'auth_all_broadcast_send_recipients') THEN
    CREATE POLICY "auth_all_broadcast_send_recipients" ON public.broadcast_send_recipients FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'broadcast_suppressions' AND policyname = 'auth_all_broadcast_suppressions') THEN
    CREATE POLICY "auth_all_broadcast_suppressions" ON public.broadcast_suppressions FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE public.broadcast_sends IS
  'A single message send to a segment/list with scheduled, per-recipient-timezone delivery. Mirrors newsletter_sends; rides the same drip. spec-broadcasts-module.md.';
COMMENT ON TABLE public.broadcast_send_recipients IS
  'Per-recipient send-timing queue for a broadcast send (one row per recipient). Clone of newsletter_send_recipients.';
COMMENT ON TABLE public.broadcast_suppressions IS
  'Topic-scoped unsubscribe/suppression. Fan-out excludes matches so a segment never re-emails an opted-out person. topic=all is the global opt-out.';
