-- ============================================================================
-- Module: broadcasts
-- Migration: 009_broadcast_replies
-- Description: Capture inbound replies to broadcast emails (mirrors the
-- newsletter replies model). The shared SendGrid Inbound Parse webhook
-- (newsletters/email-inbound-parse) matches a reply to its originating send via
-- the In-Reply-To header → email_send_log.broadcast_send_id → broadcasts, and
-- stores it here. The broadcast detail "Replies" tab reads this table.
-- ============================================================================

-- Where to forward human replies for this broadcast (optional), like the
-- newsletter collection's forward_replies_to.
ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS forward_replies_to text;

CREATE TABLE IF NOT EXISTS public.broadcast_replies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id      uuid NOT NULL REFERENCES public.broadcasts(id) ON DELETE CASCADE,
  broadcast_send_id uuid REFERENCES public.broadcast_sends(id) ON DELETE SET NULL,
  from_email        text NOT NULL,
  from_name         text,
  subject           text,
  body_text         text,
  body_html         text,
  in_reply_to       text,                                            -- Message-ID of the broadcast email
  send_log_id       uuid REFERENCES public.email_send_log(id) ON DELETE SET NULL,
  is_read           boolean NOT NULL DEFAULT false,
  is_auto_reply     boolean NOT NULL DEFAULT false,                  -- OOO / bounce classification
  auto_reply_reason text,
  forwarded_to      text,
  forwarded_at      timestamptz,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_broadcast_replies_broadcast ON public.broadcast_replies (broadcast_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcast_replies_unread ON public.broadcast_replies (broadcast_id, is_read);

ALTER TABLE public.broadcast_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS broadcast_replies_select ON public.broadcast_replies;
CREATE POLICY broadcast_replies_select ON public.broadcast_replies
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

DROP POLICY IF EXISTS broadcast_replies_update ON public.broadcast_replies;
CREATE POLICY broadcast_replies_update ON public.broadcast_replies
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

DROP POLICY IF EXISTS broadcast_replies_delete ON public.broadcast_replies;
CREATE POLICY broadcast_replies_delete ON public.broadcast_replies
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

DROP POLICY IF EXISTS broadcast_replies_insert_service ON public.broadcast_replies;
CREATE POLICY broadcast_replies_insert_service ON public.broadcast_replies
  FOR INSERT TO service_role WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.broadcast_replies TO authenticated, service_role;
