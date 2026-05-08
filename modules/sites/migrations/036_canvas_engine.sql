-- ============================================================================
-- 036_canvas_engine — track which editor engine holds the canvas lock
-- ============================================================================
--
-- Per spec-builder-evaluation §3.9. The canvas now has two possible UIs
-- (legacy SiteCanvasEditor + new PuckCanvasEditor); both write through the
-- same canvas_apply_ops contract, but the lock holder may be either. We
-- record which one so a second editor (any engine) can show "this page is
-- being edited in the Puck editor by Alice" rather than just "locked".
--
-- Also adds the per-site `canvas.engine` selector under sites_settings
-- (jsonb path), defaulting to 'legacy'. Phase E rollout flips
-- SITES_CANVAS_ENGINE_DEFAULT to 'puck' for new sites; existing sites
-- stay on legacy until owner opts in.
--
-- Idempotent.
-- ============================================================================

-- 1. page_canvas_locks.engine column
ALTER TABLE public.page_canvas_locks
  ADD COLUMN IF NOT EXISTS engine text
    NOT NULL DEFAULT 'legacy'
    CHECK (engine IN ('legacy', 'puck'));

COMMENT ON COLUMN public.page_canvas_locks.engine IS
  'Which editor UI holds the lock. Both engines persist via the same canvas_apply_ops; this is for UX (lock-handoff messaging) only. Per spec-builder-evaluation §3.9.';

-- 2. sites_settings.canvas.engine — initialised lazily by the API on first
--    read; no schema-level default needed because sites_settings is jsonb.
--    Document the expected shape in a comment so downstream readers don't
--    have to grep for it.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'sites'
       AND column_name = 'settings'
  ) THEN
    EXECUTE $cmt$
      COMMENT ON COLUMN public.sites.settings IS
        'Per-site jsonb settings bag. Recognised paths:
           canvas.engine: "legacy" | "puck" (per spec-builder-evaluation §3.7)';
    $cmt$;
  END IF;
END $$;
