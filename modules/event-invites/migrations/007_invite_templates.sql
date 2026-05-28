-- ============================================================================
-- Module: event-invites
-- Migration: 007_invite_templates
-- Description: Template system for multi-channel invite delivery.
--              Creates invite_templates, invite_template_assets,
--              invite_deliveries tables and invite-templates storage bucket.
-- ============================================================================

-- ==========================================================================
-- 1. invite_templates — one template per sub-event per channel
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.invite_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  sub_event_id uuid REFERENCES public.invite_sub_events(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('pdf', 'email', 'sms', 'whatsapp')),
  name text NOT NULL,
  subject text DEFAULT NULL,
  body text DEFAULT NULL,
  pdf_background_path text,
  pdf_fields jsonb DEFAULT '[]'::jsonb,
  is_active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, sub_event_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_invite_templates_event ON public.invite_templates(event_id);
CREATE INDEX IF NOT EXISTS idx_invite_templates_channel ON public.invite_templates(event_id, channel);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invite_templates_updated_at') THEN
    CREATE TRIGGER invite_templates_updated_at
      BEFORE UPDATE ON public.invite_templates
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ==========================================================================
-- 2. invite_template_assets — fonts and PDF backgrounds in storage
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.invite_template_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  asset_type text NOT NULL CHECK (asset_type IN ('font', 'pdf_background')),
  filename text NOT NULL,
  storage_path text NOT NULL,
  storage_bucket text NOT NULL DEFAULT 'invite-templates',
  mime_type text,
  file_size integer,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invite_template_assets_event ON public.invite_template_assets(event_id);

-- ==========================================================================
-- 3. invite_deliveries — multi-channel delivery log
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.invite_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES public.invite_parties(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('pdf', 'email', 'sms', 'whatsapp')),
  template_id uuid REFERENCES public.invite_templates(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'downloaded')),
  sent_at timestamptz,
  delivered_at timestamptz,
  error_message text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invite_deliveries_party ON public.invite_deliveries(party_id);
CREATE INDEX IF NOT EXISTS idx_invite_deliveries_channel ON public.invite_deliveries(party_id, channel);

-- ==========================================================================
-- 4. Storage bucket for template assets
-- ==========================================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('invite-templates', 'invite-templates', true)
ON CONFLICT (id) DO NOTHING;

-- ==========================================================================
-- 5. Migrate existing delivery data
-- ==========================================================================
INSERT INTO public.invite_deliveries (party_id, channel, status, sent_at, created_at)
SELECT id, COALESCE(delivery_channel, 'email'), 'sent', sent_at, sent_at
FROM public.invite_parties
WHERE sent_at IS NOT NULL
ON CONFLICT DO NOTHING;

-- ==========================================================================
-- 6. RLS Policies
-- ==========================================================================
ALTER TABLE public.invite_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_template_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_deliveries ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'invite_templates' AND policyname = 'authenticated_all_invite_templates') THEN
    CREATE POLICY "authenticated_all_invite_templates"
      ON public.invite_templates FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'invite_template_assets' AND policyname = 'authenticated_all_invite_template_assets') THEN
    CREATE POLICY "authenticated_all_invite_template_assets"
      ON public.invite_template_assets FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'invite_deliveries' AND policyname = 'authenticated_all_invite_deliveries') THEN
    CREATE POLICY "authenticated_all_invite_deliveries"
      ON public.invite_deliveries FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Storage policies
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'objects' AND policyname = 'invite_templates_public_read') THEN
    CREATE POLICY "invite_templates_public_read"
      ON storage.objects FOR SELECT TO public
      USING (bucket_id = 'invite-templates');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'objects' AND policyname = 'invite_templates_auth_write') THEN
    CREATE POLICY "invite_templates_auth_write"
      ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'invite-templates');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'objects' AND policyname = 'invite_templates_auth_update') THEN
    CREATE POLICY "invite_templates_auth_update"
      ON storage.objects FOR UPDATE TO authenticated
      USING (bucket_id = 'invite-templates');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'objects' AND policyname = 'invite_templates_auth_delete') THEN
    CREATE POLICY "invite_templates_auth_delete"
      ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'invite-templates');
  END IF;
END $$;
