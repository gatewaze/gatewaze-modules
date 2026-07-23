-- ============================================================================
-- Module: broadcasts
-- Migration: 015_broadcast_type
-- Description: Add a `type` to a broadcast — METADATA only (per
-- spec-broadcasts-blocks.md §4.1). It labels the broadcast in lists/stats,
-- groups reporting, and drives sensible defaults (starter block set, subject/
-- preheader patterns, and letting the event→broadcast flow tag its output
-- 'event_recap'). It does NOT restrict which blocks are available in the
-- builder (v1) — the palette is gated by module ownership, not by type.
-- ============================================================================

ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'general';

COMMENT ON COLUMN public.broadcasts.type IS
  'Metadata label for the broadcast (general|event_promo|event_recap|cfp_invite|…). Used for list/stats grouping + defaults. Does NOT filter the block palette (v1). Per spec-broadcasts-blocks §4.1.';
