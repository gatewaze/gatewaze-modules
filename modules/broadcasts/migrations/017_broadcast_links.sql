-- ============================================================================
-- Module: broadcasts
-- Migration: 017_broadcast_links
-- Description: Per-block link registry for broadcasts — a clone of the
-- newsletters_edition_links "tracking-key registry" shape (newsletters
-- migration 032), keyed by broadcast instead of edition. Each trackable link
-- occurrence in the rendered body gets an opaque tracking_key that is appended
-- to the URL as ?nlb=<key>; the SendGrid email-webhook resolves the key back to
-- (block_id, block_type) and writes them onto email_interactions, so clicks
-- attribute per block. Per spec-broadcasts-blocks.md §5.4.
--
-- Isolation choice (spec §11 Q2): a dedicated table now (webhook falls back to
-- it when the newsletter lookup misses), converge into one shared email_links
-- table later if worthwhile.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.broadcast_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id  uuid NOT NULL REFERENCES public.broadcasts(id) ON DELETE CASCADE,
  -- Optional per-send scoping snapshot; the parent registry is the source of
  -- truth, sends inherit the same tracking_keys.
  send_id       uuid REFERENCES public.broadcast_sends(id) ON DELETE CASCADE,
  block_id      uuid NOT NULL REFERENCES public.broadcast_blocks(id) ON DELETE CASCADE,
  brick_id      uuid REFERENCES public.broadcast_bricks(id) ON DELETE SET NULL,
  tracking_key  text NOT NULL UNIQUE,          -- the opaque ?nlb= value
  block_type    text NOT NULL,                 -- denormalized for webhook resolve
  tracking_slug text,
  field         text NOT NULL,                 -- field/anchor path the link came from
  link_index    integer NOT NULL DEFAULT 0,    -- stable position within (block_id, field)
  original_url  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Idempotent re-save key: re-rendering a broadcast reuses the same key for the
  -- same occurrence, so historical click attribution stays stable.
  CONSTRAINT broadcast_links_occurrence_key UNIQUE (block_id, field, link_index)
);

CREATE INDEX IF NOT EXISTS broadcast_links_broadcast ON public.broadcast_links (broadcast_id);
CREATE INDEX IF NOT EXISTS broadcast_links_block ON public.broadcast_links (block_id);
CREATE INDEX IF NOT EXISTS broadcast_links_block_type ON public.broadcast_links (block_type);

CREATE TRIGGER broadcast_links_updated_at
  BEFORE UPDATE ON public.broadcast_links
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.broadcast_links ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'broadcast_links' AND policyname = 'auth_all_broadcast_links') THEN
    CREATE POLICY "auth_all_broadcast_links" ON public.broadcast_links FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- The webhook (service role, and possibly running before broadcasts RLS context
-- exists) resolves tracking_key → block on click; allow anon/service SELECT of
-- the resolve columns, mirroring newsletters migration 023's anon-read of defs.
GRANT SELECT ON public.broadcast_links TO anon, authenticated, service_role;

COMMENT ON TABLE public.broadcast_links IS
  'Per-occurrence ?nlb= tracking-key registry for broadcast block links (clone of newsletters_edition_links post-032). Resolved by the SendGrid email-webhook to attribute clicks per block. Per spec-broadcasts-blocks §5.4.';
