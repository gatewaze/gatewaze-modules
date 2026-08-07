-- ============================================================================
-- Module: bulk-emailing
-- Migration: 025_event_replies
-- Description: Inbound replies to EVENT comms, mirroring the broadcast and
--              newsletter replies model so the shared RepliesWorkspace UI and
--              reply-send composer work unchanged.
--
--              Correlation needs no new outbound instrumentation: the send
--              engine already writes an email_send_log row per recipient with
--              batch_job_id (-> email_batch_jobs.event_id),
--              provider_message_id and recipient_email — the same key the
--              newsletter/broadcast matchers use via the In-Reply-To header.
--
--              is_starred/is_archived are here from day one rather than
--              bolted on later, as happened for newsletters (migration 065)
--              and broadcasts (012).
-- ============================================================================

-- Optional forwarding target per comms job, like broadcasts.forward_replies_to.
ALTER TABLE public.email_batch_jobs
  ADD COLUMN IF NOT EXISTS forward_replies_to text;

CREATE TABLE IF NOT EXISTS public.event_replies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  batch_job_id      uuid REFERENCES public.email_batch_jobs(id) ON DELETE SET NULL,
  from_email        text NOT NULL,
  from_name         text,
  subject           text,
  body_text         text,
  body_html         text,
  in_reply_to       text,
  send_log_id       uuid REFERENCES public.email_send_log(id) ON DELETE SET NULL,
  is_read           boolean NOT NULL DEFAULT false,
  is_starred        boolean NOT NULL DEFAULT false,
  is_archived       boolean NOT NULL DEFAULT false,
  is_auto_reply     boolean NOT NULL DEFAULT false,
  auto_reply_reason text,
  forwarded_to      text,
  forwarded_at      timestamptz,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_replies_event ON public.event_replies (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_replies_unread ON public.event_replies (event_id, is_read);

-- Outbound admin replies in the thread (mirrors broadcast_reply_messages).
CREATE TABLE IF NOT EXISTS public.event_reply_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reply_id      uuid NOT NULL REFERENCES public.event_replies(id) ON DELETE CASCADE,
  event_id      uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  to_email      text NOT NULL,
  from_email    text,
  subject       text,
  body_html     text,
  body_text     text,
  sent_by       uuid,
  send_log_id   uuid REFERENCES public.email_send_log(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_reply_messages_reply ON public.event_reply_messages (reply_id, created_at);

ALTER TABLE public.event_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_reply_messages ENABLE ROW LEVEL SECURITY;

-- Same shape as broadcast_replies: active admins read/update/delete,
-- service_role inserts. Replies contain private correspondence — no anon.
DROP POLICY IF EXISTS event_replies_select ON public.event_replies;
CREATE POLICY event_replies_select ON public.event_replies
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

DROP POLICY IF EXISTS event_replies_update ON public.event_replies;
CREATE POLICY event_replies_update ON public.event_replies
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

DROP POLICY IF EXISTS event_replies_delete ON public.event_replies;
CREATE POLICY event_replies_delete ON public.event_replies
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

DROP POLICY IF EXISTS event_replies_insert_service ON public.event_replies;
CREATE POLICY event_replies_insert_service ON public.event_replies
  FOR INSERT TO service_role WITH CHECK (true);

DROP POLICY IF EXISTS event_reply_messages_select ON public.event_reply_messages;
CREATE POLICY event_reply_messages_select ON public.event_reply_messages
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

DROP POLICY IF EXISTS event_reply_messages_insert_service ON public.event_reply_messages;
CREATE POLICY event_reply_messages_insert_service ON public.event_reply_messages
  FOR INSERT TO service_role WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_replies TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_reply_messages TO authenticated, service_role;
