-- ============================================================================
-- Module: newsletters
-- Migration: 064_newsletter_reply_messages
-- Description: Outbound admin replies to a newsletter reply — the "reply to a
-- reply" composer in the Replies tab. Each row is one email we sent back to a
-- person who replied, dispatched by the `reply-send` edge function FROM the
-- collection's sending address (so the person's next reply routes back to
-- email-inbound-parse and is forwarded to forward_replies_to like any other
-- reply). Recorded here so the tab can show the conversation thread.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.newsletter_reply_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reply_id            uuid NOT NULL REFERENCES public.newsletter_replies(id) ON DELETE CASCADE,
  collection_id       uuid REFERENCES public.newsletters_template_collections(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_newsletter_reply_messages_reply
  ON public.newsletter_reply_messages (reply_id, created_at);
CREATE INDEX IF NOT EXISTS idx_newsletter_reply_messages_collection
  ON public.newsletter_reply_messages (collection_id, created_at DESC);

ALTER TABLE public.newsletter_reply_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS newsletter_reply_messages_select ON public.newsletter_reply_messages;
CREATE POLICY newsletter_reply_messages_select ON public.newsletter_reply_messages
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

-- Inserts are done by the reply-send edge function under the service role.
DROP POLICY IF EXISTS newsletter_reply_messages_insert_service ON public.newsletter_reply_messages;
CREATE POLICY newsletter_reply_messages_insert_service ON public.newsletter_reply_messages
  FOR INSERT TO service_role WITH CHECK (true);

GRANT SELECT ON public.newsletter_reply_messages TO authenticated;
GRANT SELECT, INSERT ON public.newsletter_reply_messages TO service_role;
