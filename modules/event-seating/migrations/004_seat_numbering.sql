-- ============================================================================
-- Module: event-seating
-- Migration: 004_seat_numbering
-- Description: How seats are numbered for guests and the venue.
--
--              'per_table' numbers each table 1..n, which reads well in a room
--              of separate round tables: "Table 4, seat 3".
--
--              'continuous' numbers every seat in the plan 1..N. Once tables
--              are pushed together into a U or a long bank, covered with
--              linen and joined, nobody can tell one table from another on the
--              day — so a table name identifies nothing and eleven tables each
--              having a seat 1 makes a meal sheet unusable. A number unique
--              across the room is the only thing a waiter can act on.
--
--              Continuous is the default, including for existing plans: it is
--              the safe reading either way, since a room of separate tables
--              still has unique numbers, just not ones that restart.
-- ============================================================================

ALTER TABLE public.seating_plans
  ADD COLUMN IF NOT EXISTS seat_numbering text NOT NULL DEFAULT 'continuous';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'seating_plans_seat_numbering_check'
  ) THEN
    ALTER TABLE public.seating_plans
      ADD CONSTRAINT seating_plans_seat_numbering_check
      CHECK (seat_numbering IN ('per_table', 'continuous'));
  END IF;
END $$;

COMMENT ON COLUMN public.seating_plans.seat_numbering IS
  'per_table = each table numbered 1..n; continuous = every seat in the plan numbered 1..N';
