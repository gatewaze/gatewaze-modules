-- ============================================================================
-- Module: badge-scanning
-- Migration: 003_badge_scanning_rpc
-- Description: RPC functions for badge scanning module.
--              events_get_sponsor_scan_stats moved from core 00008_rpc_functions.sql
--              and updated to reference events_contact_scans.
-- ============================================================================

-- ==========================================================================
-- 1. events_get_sponsor_scan_stats
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.events_get_sponsor_scan_stats(p_event_sponsor_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'total_scans',     COUNT(*)::int,
    'unique_contacts', COUNT(DISTINCT scanned_people_profile_id)::int
  )
  FROM public.events_contact_scans
  WHERE event_sponsor_id = p_event_sponsor_id;
$$;

COMMENT ON FUNCTION public.events_get_sponsor_scan_stats(uuid)
  IS 'Total and unique scan counts for a sponsor at an event';
