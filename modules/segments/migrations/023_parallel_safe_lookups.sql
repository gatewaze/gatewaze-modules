-- ============================================================================
-- Module: segments
-- Migration: 023_parallel_safe_lookups
-- Description: mark the per-person lookups from 021 and 022 PARALLEL SAFE.
--
-- Functions default to PARALLEL UNSAFE, and one unsafe call in a WHERE clause
-- stops Postgres using parallel workers for the whole query. On AAIF an
-- audience with these conditions scanned all 192k people on one core, and
-- the builder preview (a count plus a sample) took over 8s and timed out.
-- Marked safe, the same preview takes about 3s.
--
-- Both functions only read tables and write nothing, so they are safe to run
-- in a parallel worker.
-- ============================================================================

ALTER FUNCTION public.segments_email_activity_has(text, text, integer) PARALLEL SAFE;
ALTER FUNCTION public.segments_suppression_has(uuid, text) PARALLEL SAFE;
