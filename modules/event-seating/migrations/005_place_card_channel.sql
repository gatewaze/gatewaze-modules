-- ============================================================================
-- Module: event-seating
-- Migration: 005_place_card_channel
-- Description: Allow 'place_card' as an invite_templates channel. Place-card
--              templates live in the event-invites template system (which
--              this module already depends on for guests and RSVP answers),
--              so they share the event's uploaded fonts and the same
--              sub-event-then-default matching as every other channel.
-- ============================================================================

DO $$
DECLARE
  con record;
BEGIN
  -- event-seating declares a dependency on event-invites, so the table is
  -- expected to exist; the guard keeps a partial install from failing here.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'invite_templates'
  ) THEN
    -- Drop every CHECK on the channel column by catalogue lookup rather than
    -- by its expected auto-generated name: if the name ever differed, a named
    -- DROP IF EXISTS would silently no-op and the old four-channel check
    -- would survive alongside the new one, rejecting 'place_card' rows.
    FOR con IN
      SELECT pc.conname
      FROM pg_constraint pc
      JOIN pg_class rel ON rel.oid = pc.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE nsp.nspname = 'public'
        AND rel.relname = 'invite_templates'
        AND pc.contype = 'c'
        AND pg_get_constraintdef(pc.oid) ILIKE '%channel%'
    LOOP
      EXECUTE format('ALTER TABLE public.invite_templates DROP CONSTRAINT %I', con.conname);
    END LOOP;

    ALTER TABLE public.invite_templates
      ADD CONSTRAINT invite_templates_channel_check
      CHECK (channel IN ('pdf', 'email', 'sms', 'whatsapp', 'place_card'));
  END IF;
END $$;
