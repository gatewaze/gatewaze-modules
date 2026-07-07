-- ============================================================================
-- Module: broadcasts
-- Migration: 011_broadcast_reply_messages
-- Description: Outbound admin replies to a broadcast reply — the "reply to a
-- reply" composer in the Replies tab. Each row is one email we sent back to a
-- person who replied, dispatched by the `reply-send` edge function FROM the
-- broadcast's original sending address (so the person's next reply routes back
-- to email-inbound-parse and is forwarded to forward_replies_to like any other
-- reply). Recorded here so the tab can show the conversation thread.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.broadcast_reply_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reply_id            uuid NOT NULL REFERENCES public.broadcast_replies(id) ON DELETE CASCADE,
  broadcast_id        uuid REFERENCES public.broadcasts(id) ON DELETE CASCADE,
  from_address        text NOT NULL,
  to_address          text NOT NULL,
  subject             text,
  body_html           text,
  body_text           text,
  attachments         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ filename, type, size }]
  provider_message_id text,
  sent_by             uuid,                                 -- auth.users id of the admin who sent it
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_broadcast_reply_messages_reply
  ON public.broadcast_reply_messages (reply_id, created_at);
CREATE INDEX IF NOT EXISTS idx_broadcast_reply_messages_broadcast
  ON public.broadcast_reply_messages (broadcast_id, created_at DESC);

ALTER TABLE public.broadcast_reply_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS broadcast_reply_messages_select ON public.broadcast_reply_messages;
CREATE POLICY broadcast_reply_messages_select ON public.broadcast_reply_messages
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

-- Inserts are done by the reply-send edge function under the service role.
DROP POLICY IF EXISTS broadcast_reply_messages_insert_service ON public.broadcast_reply_messages;
CREATE POLICY broadcast_reply_messages_insert_service ON public.broadcast_reply_messages
  FOR INSERT TO service_role WITH CHECK (true);

GRANT SELECT ON public.broadcast_reply_messages TO authenticated;
GRANT SELECT, INSERT ON public.broadcast_reply_messages TO service_role;
