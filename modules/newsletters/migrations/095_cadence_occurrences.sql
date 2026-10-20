-- ============================================================================
-- 095_cadence_occurrences
-- ============================================================================
-- Edition cadence (spec-content-discovery-and-research-blocks.md §6). A
-- newsletter with a cadence gets its next edition created ahead of time by
-- the hourly tick. The IDENTITY of an auto-created edition is the occurrence
-- row, not a lookup on send_target_at: the primary key stops two workers or
-- a restart creating two editions, and a human moving or deleting the
-- edition does not free the slot, so Monday's issue is not recreated every
-- hour. A skipped slot ("no issue over the holidays") is a row too.
-- Idempotent.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.newsletters_cadence_occurrences (
  collection_id  uuid NOT NULL REFERENCES public.newsletters_template_collections(id) ON DELETE CASCADE,
  slot           timestamptz NOT NULL,          -- the computed send_target_at
  state          text NOT NULL CHECK (state IN ('created','skipped')),
  edition_id     uuid REFERENCES public.newsletters_editions(id) ON DELETE SET NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, slot)
);
COMMENT ON TABLE public.newsletters_cadence_occurrences IS
  'One row per cadence slot per collection: created (with its edition) or skipped. The primary key is the identity the cadence tick checks.';

ALTER TABLE public.newsletters_cadence_occurrences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cadence_occ_admin ON public.newsletters_cadence_occurrences;
CREATE POLICY cadence_occ_admin ON public.newsletters_cadence_occurrences
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.newsletters_cadence_occurrences TO authenticated;
GRANT ALL ON public.newsletters_cadence_occurrences TO service_role;

-- Deleting a cadence edition marks its slot skipped. This trigger is the
-- only place that happens: the editor's delete (EditorTab) is a plain row
-- delete. ON DELETE SET NULL clears edition_id; this flips the state so the
-- tick never recreates it.
CREATE OR REPLACE FUNCTION public.newsletters_cadence_edition_deleted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.newsletters_cadence_occurrences
     SET state = 'skipped', note = coalesce(note, '') || ' edition deleted ' || now()::date
   WHERE edition_id = OLD.id AND state = 'created';
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS newsletters_cadence_edition_deleted ON public.newsletters_editions;
CREATE TRIGGER newsletters_cadence_edition_deleted BEFORE DELETE ON public.newsletters_editions
  FOR EACH ROW EXECUTE FUNCTION public.newsletters_cadence_edition_deleted();
