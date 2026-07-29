-- ============================================================================
-- Module: newsletters
-- Migration: 075_preview_security_definer
-- Description: Make newsletter_preview_send_schedule SECURITY DEFINER (like the
-- broadcast preview + newsletter_recipient_preview_count). Called via PostgREST
-- as `authenticated`, it otherwise evaluates per-row RLS over people (11
-- policies) and list_subscriptions for the whole list — pushing a ~0.5s query to
-- ~7s, which trips the 8s statement_timeout (57014) under any load. The function
-- only returns aggregate per-timezone counts, so bypassing RLS is safe and keeps
-- it sub-second.
-- ============================================================================

ALTER FUNCTION public.newsletter_preview_send_schedule(uuid, timestamptz, text, text)
  SECURITY DEFINER SET search_path = public;
