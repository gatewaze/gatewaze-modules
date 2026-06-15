-- Per-recipient Customer.io engagement profile across the FULL weekly history
-- (all 143 weeklies, not just editions mapped into gatewaze). Decouples
-- cross-edition click corroboration from gatewaze edition mapping, so a
-- recipient who ever clicked anywhere in the CIO history counts as a confirmed
-- human even if that edition isn't (yet) imported. Spec §6 (Part C).

CREATE TABLE IF NOT EXISTS public.cio_recipient_engagement (
  recipient_email     text PRIMARY KEY,
  cio_id              text,
  editions_delivered  integer NOT NULL DEFAULT 0,
  editions_opened     integer NOT NULL DEFAULT 0,
  editions_clicked    integer NOT NULL DEFAULT 0,
  first_seen          timestamptz,
  last_open           timestamptz,
  last_click          timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cio_reng_clicked
  ON public.cio_recipient_engagement(editions_clicked) WHERE editions_clicked > 0;

ALTER TABLE public.cio_recipient_engagement ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'cio_recipient_engagement'
      AND policyname = 'auth_all_cio_recipient_engagement'
  ) THEN
    CREATE POLICY "auth_all_cio_recipient_engagement"
      ON public.cio_recipient_engagement
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE public.cio_recipient_engagement IS
  'Per-recipient Customer.io engagement across the full weekly history; powers cross-edition click corroboration (spec §6 Part C).';
