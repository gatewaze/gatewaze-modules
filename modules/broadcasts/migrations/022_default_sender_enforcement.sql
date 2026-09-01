-- ============================================================================
-- Module: broadcasts
-- Migration: 022_default_sender_enforcement
-- Description: Guarantee every broadcast (and every send it spawns) carries
-- explicit sender details, so a send can never fall through to the env
-- no-reply/localhost address (which lands in spam and misaligns SPF/DKIM/DMARC).
--
-- Mechanism (generic — no per-brand value here): a BEFORE INSERT trigger fills a
-- missing from_address / from_name from the global platform_settings defaults
-- (keys 'broadcast_from_address' / 'broadcast_from_name'). Each install sets
-- those values to its own verified sender; if unset the columns stay NULL and
-- the send path's configured BULK_EMAIL_FROM_ADDRESS still applies (the app
-- layer now refuses to send with no resolvable From, rather than using a
-- hard-coded no-reply fallback).
--
-- Precedence at insert: explicit column value > platform_settings default.
-- broadcast_sends copy the parent's From at creation, so parent > default flows
-- through naturally; the trigger is the floor for either table.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.broadcasts_default_sender()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NULLIF(NEW.from_address, '') IS NULL THEN
    NEW.from_address := NULLIF((SELECT value FROM public.platform_settings WHERE key = 'broadcast_from_address'), '');
  END IF;
  IF NULLIF(NEW.from_name, '') IS NULL THEN
    NEW.from_name := NULLIF((SELECT value FROM public.platform_settings WHERE key = 'broadcast_from_name'), '');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_broadcasts_default_sender ON public.broadcasts;
CREATE TRIGGER trg_broadcasts_default_sender
  BEFORE INSERT ON public.broadcasts
  FOR EACH ROW EXECUTE FUNCTION public.broadcasts_default_sender();

DROP TRIGGER IF EXISTS trg_broadcast_sends_default_sender ON public.broadcast_sends;
CREATE TRIGGER trg_broadcast_sends_default_sender
  BEFORE INSERT ON public.broadcast_sends
  FOR EACH ROW EXECUTE FUNCTION public.broadcasts_default_sender();

-- Backfill existing broadcast DEFINITIONS (parents) that never captured a
-- sender, so their next send inherits the default. Only fills when a global
-- default is configured (COALESCE leaves NULL untouched otherwise). Historical
-- broadcast_sends are intentionally left as-is — rewriting a completed send's
-- From would misrepresent what actually went out.
UPDATE public.broadcasts b
SET from_address = COALESCE(NULLIF(b.from_address, ''), (SELECT value FROM public.platform_settings WHERE key = 'broadcast_from_address')),
    from_name    = COALESCE(NULLIF(b.from_name, ''),    (SELECT value FROM public.platform_settings WHERE key = 'broadcast_from_name'))
WHERE NULLIF(b.from_address, '') IS NULL
   OR NULLIF(b.from_name, '') IS NULL;
