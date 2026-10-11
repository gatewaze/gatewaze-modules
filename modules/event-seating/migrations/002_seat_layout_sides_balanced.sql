-- ============================================================================
-- Module: event-seating
-- Migration: 002_seat_layout_sides_balanced
-- Description: Allow the 'sides_balanced' seat layout.
--
--              'around' spreads seats over the whole perimeter in proportion
--              to edge length, so an odd seat count puts a different number on
--              each long side (a 9-seater becomes 4 / 3 plus both ends) and
--              nobody sits directly opposite anyone. 'sides_balanced' seats an
--              equal number down both long sides and puts the odd one at the
--              far end — 4 / 4 / 1 — so guests line up across the table.
-- ============================================================================

ALTER TABLE public.seating_tables
  DROP CONSTRAINT IF EXISTS seating_tables_seat_layout_check;

ALTER TABLE public.seating_tables
  ADD CONSTRAINT seating_tables_seat_layout_check
  CHECK (seat_layout IN ('around', 'both_sides', 'sides_balanced', 'one_side'));
