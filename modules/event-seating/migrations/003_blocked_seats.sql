-- ============================================================================
-- Module: event-seating
-- Migration: 003_blocked_seats
-- Description: Let individual seats on a table be taken out of use.
--
--              Tables get pushed together into U shapes, horseshoes and long
--              banks, and where two tables meet the seats on the touching
--              edges cannot be sat in. Seat positions stay derived from the
--              table's shape, size and seat count — this records which of
--              those positions are blocked, by geometric seat index.
--
--              Blocking is presentation-and-capacity only: a blocked seat is
--              not drawn, cannot be dropped on, and does not count towards
--              the table's capacity. Indices stay stable when a seat is
--              blocked, so unblocking restores the original arrangement; the
--              numbering shown to guests and the venue is derived from the
--              seats actually in use.
-- ============================================================================

ALTER TABLE public.seating_tables
  ADD COLUMN IF NOT EXISTS disabled_seats integer[] NOT NULL DEFAULT '{}'::integer[];

COMMENT ON COLUMN public.seating_tables.disabled_seats IS
  'Geometric seat indices taken out of use, e.g. where another table abuts this one';

-- Guard the array: indices must be within the addressable seat range.
-- (Against seat_count would be stricter, but shrinking a table would then
-- have to rewrite the array in the same statement; the editor prunes stale
-- entries when the seat count changes.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'seating_tables_disabled_seats_range'
  ) THEN
    ALTER TABLE public.seating_tables
      ADD CONSTRAINT seating_tables_disabled_seats_range
      -- Spelled out rather than generated: CHECK forbids subqueries, and a
      -- literal keeps the constraint immutable and re-validatable without
      -- depending on a helper function.
      CHECK (
        disabled_seats <@ ARRAY[
           0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
          10,11,12,13,14,15,16,17,18,19,
          20,21,22,23,24,25,26,27,28,29,
          30,31,32,33,34,35,36,37,38,39
        ]::integer[]
      );
  END IF;
END $$;

-- A blocked seat must not have somebody in it. Enforced in the editor by
-- unseating first; this catches anything that gets there another way.
CREATE OR REPLACE FUNCTION public.seating_assignment_seat_not_blocked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  blocked integer[];
BEGIN
  SELECT disabled_seats INTO blocked
  FROM public.seating_tables
  WHERE id = NEW.table_id;

  IF blocked IS NOT NULL AND NEW.seat_index = ANY (blocked) THEN
    RAISE EXCEPTION 'Seat % on table % is out of use', NEW.seat_index, NEW.table_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS seating_assignments_seat_not_blocked ON public.seating_assignments;
CREATE TRIGGER seating_assignments_seat_not_blocked
  BEFORE INSERT OR UPDATE OF table_id, seat_index ON public.seating_assignments
  FOR EACH ROW EXECUTE FUNCTION public.seating_assignment_seat_not_blocked();
