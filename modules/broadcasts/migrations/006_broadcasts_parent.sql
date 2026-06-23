-- ============================================================================
-- Module: broadcasts
-- Migration: 006_broadcasts_parent
-- Description: Restructure broadcasts to the uniform "parent content entity →
-- many sends → recipients" model (same as newsletter edition → newsletter_sends,
-- event → email_batch_jobs). Introduces a `broadcasts` PARENT (the definition +
-- draft content + audience), and `broadcast_sends` becomes the SEND INSTANCES of
-- a broadcast (gains broadcast_id). Each send keeps its existing content columns
-- as a per-send snapshot, so the worker binding is unchanged. This lets the
-- shared SendingPanel list/create many sends per broadcast.
-- ADDITIVE: existing broadcast_sends rows are each backfilled a parent (1:1).
-- ============================================================================

-- Parent: the broadcast definition + draft content + audience. Edited in the
-- composer (From / Recipients are editable here); sends snapshot from it.
CREATE TABLE IF NOT EXISTS public.broadcasts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  brand            text NOT NULL DEFAULT 'default',
  channel          text NOT NULL DEFAULT 'email',
  audience_type    text NOT NULL DEFAULT 'segment',
  segment_id       uuid,
  list_ids         text[] NOT NULL DEFAULT '{}',
  category_list_id uuid REFERENCES public.lists(id),
  subject          text,
  preheader        text,
  from_address     text,
  from_name        text,
  reply_to         text,
  body_text        text,
  content_json     jsonb NOT NULL DEFAULT '{}'::jsonb,
  rendered_html    text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER broadcasts_updated_at
  BEFORE UPDATE ON public.broadcasts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.broadcasts ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'broadcasts' AND policyname = 'auth_all_broadcasts') THEN
    CREATE POLICY "auth_all_broadcasts" ON public.broadcasts FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Send instances point at their parent broadcast.
ALTER TABLE public.broadcast_sends
  ADD COLUMN IF NOT EXISTS broadcast_id uuid REFERENCES public.broadcasts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_broadcast_sends_broadcast ON public.broadcast_sends (broadcast_id, created_at DESC);

-- Backfill: every existing send gets a parent (1:1), copying its definition.
DO $$
DECLARE r record; pid uuid;
BEGIN
  FOR r IN SELECT * FROM public.broadcast_sends WHERE broadcast_id IS NULL LOOP
    INSERT INTO public.broadcasts
      (name, brand, channel, audience_type, segment_id, list_ids, category_list_id, subject, preheader,
       from_address, from_name, reply_to, body_text, content_json, rendered_html, created_by, created_at, updated_at)
    VALUES
      (COALESCE(r.name, 'Broadcast'), COALESCE(r.brand,'default'), COALESCE(r.channel,'email'),
       COALESCE(r.audience_type,'segment'), r.segment_id, COALESCE(r.list_ids, '{}'), r.category_list_id,
       r.subject, r.preheader, r.from_address, r.from_name, r.reply_to, r.body_text,
       COALESCE(r.content_json,'{}'::jsonb), r.rendered_html, r.created_by, r.created_at, r.updated_at)
    RETURNING id INTO pid;
    UPDATE public.broadcast_sends SET broadcast_id = pid WHERE id = r.id;
  END LOOP;
END $$;

COMMENT ON TABLE public.broadcasts IS
  'Broadcast parent (definition + draft content + audience). broadcast_sends are its send instances (uniform parent→sends model, like newsletter editions).';
