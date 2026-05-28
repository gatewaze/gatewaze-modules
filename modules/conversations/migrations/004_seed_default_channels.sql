-- ============================================================================
-- Module: conversations
-- Migration: 004_seed_default_channels
-- Description: Backfill one default conversations row per existing calendar
--              and per existing future event (if those modules are installed).
--              Idempotent — safe to re-run.
--              Per spec-conversations-module.md §14 Phase 1 / Phase 2.
-- ============================================================================

-- ==========================================================================
-- 1. One default channel per calendar
-- ==========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='calendars') THEN
    INSERT INTO public.conversations (
      kind, calendar_id, title, is_default, visibility, require_username
    )
    SELECT
      'calendar_channel',
      c.id,
      c.name || ' chat',
      true,
      'members',
      true
    FROM public.calendars c
    WHERE c.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM public.conversations existing
        WHERE existing.calendar_id = c.id
          AND existing.kind = 'calendar_channel'
          AND existing.is_default = true
      );
  END IF;
END $$;

-- ==========================================================================
-- 2. One default channel per upcoming event
-- ==========================================================================
INSERT INTO public.conversations (
  kind, event_id, title, is_default, visibility, require_username
)
SELECT
  'event_channel',
  e.id,
  e.event_title || ' chat',
  true,
  'registered',
  true
FROM public.events e
WHERE e.is_live_in_production = true
  AND (e.event_start IS NULL OR e.event_start > now() - interval '1 day')
  AND NOT EXISTS (
    SELECT 1 FROM public.conversations existing
    WHERE existing.event_id = e.id
      AND existing.kind = 'event_channel'
      AND existing.is_default = true
  );

-- ==========================================================================
-- 3. Trigger: auto-create event channel on event INSERT going forward
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.create_default_event_channel()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_live_in_production = true THEN
    INSERT INTO public.conversations (
      kind, event_id, title, is_default, visibility, require_username
    )
    VALUES (
      'event_channel',
      NEW.id,
      NEW.event_title || ' chat',
      true,
      'registered',
      true
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_create_default_channel ON public.events;
CREATE TRIGGER events_create_default_channel
  AFTER INSERT ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.create_default_event_channel();
