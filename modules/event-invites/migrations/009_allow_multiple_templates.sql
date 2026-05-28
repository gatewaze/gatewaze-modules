-- ============================================================================
-- Module: event-invites
-- Migration: 009_allow_multiple_templates
-- Description: Drops the unique (event_id, sub_event_id, channel) constraint
--              on invite_templates so that multiple templates (e.g.
--              duplicates, variants) can coexist for the same sub-event +
--              channel. The `is_active` flag picks the template used for
--              sending/printing (see findMatchingTemplate).
-- ============================================================================

ALTER TABLE public.invite_templates
  DROP CONSTRAINT IF EXISTS invite_templates_event_id_sub_event_id_channel_key;
