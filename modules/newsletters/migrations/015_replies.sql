-- Add forward_replies_to to newsletter collections and create replies table.

-- Forward address: replies to the newsletter sending address are forwarded here
ALTER TABLE public.newsletters_template_collections
  ADD COLUMN IF NOT EXISTS forward_replies_to text;

-- Replies table: stores inbound email replies to newsletter sending addresses
CREATE TABLE IF NOT EXISTS public.newsletter_replies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id     uuid NOT NULL REFERENCES public.newsletters_template_collections(id) ON DELETE CASCADE,
  from_email        text NOT NULL,
  from_name         text,
  subject           text,
  body_text         text,
  body_html         text,
  in_reply_to       text,             -- Message-ID of the newsletter email
  send_log_id       uuid REFERENCES public.email_send_log(id) ON DELETE SET NULL,
  edition_id        uuid REFERENCES public.newsletters_editions(id) ON DELETE SET NULL,
  is_read           boolean DEFAULT false,
  forwarded_to      text,
  forwarded_at      timestamptz,
  metadata          jsonb DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_newsletter_replies_collection ON public.newsletter_replies (collection_id);
CREATE INDEX IF NOT EXISTS idx_newsletter_replies_created ON public.newsletter_replies (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_newsletter_replies_is_read ON public.newsletter_replies (collection_id, is_read);

-- RLS
ALTER TABLE public.newsletter_replies ENABLE ROW LEVEL SECURITY;

CREATE POLICY newsletter_replies_select ON public.newsletter_replies
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

CREATE POLICY newsletter_replies_update ON public.newsletter_replies
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

CREATE POLICY newsletter_replies_delete ON public.newsletter_replies
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND is_active = true)
  );

-- Service role insert (edge function)
CREATE POLICY newsletter_replies_insert_service ON public.newsletter_replies
  FOR INSERT TO service_role WITH CHECK (true);
