-- ============================================================================
-- Module: newsletters
-- Migration: 090_require_send_preheader
-- Description: every newsletter send must carry a preheader. Gmail files mail
-- without one as spam, and people were forgetting to fill it in. The admin
-- blocks Send without one; this is the server-side backstop for any other
-- path that creates a send row.
--
-- The admin now writes the edition's preheader onto the send. When a caller
-- leaves it NULL, fall back to the edition's saved preheader (which also
-- records it on the send for history), and reject the insert if that is
-- blank too.
--
-- BEFORE INSERT only, deliberately: the engine updates send rows throughout a
-- send (counts, status, completed_at), and a CHECK constraint (even NOT VALID)
-- is re-evaluated on every UPDATE, which would break sends already in flight
-- that predate this rule. Whitespace-only does not count.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.newsletter_sends_require_preheader()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF btrim(coalesce(NEW.preheader, '')) = '' AND NEW.edition_id IS NOT NULL THEN
    SELECT nullif(btrim(e.preheader), '') INTO NEW.preheader
    FROM public.newsletters_editions e
    WHERE e.id = NEW.edition_id;
  END IF;
  IF btrim(coalesce(NEW.preheader, '')) = '' THEN
    RAISE EXCEPTION 'A preheader is required before sending. Add one on the edition''s Details tab.'
      USING ERRCODE = 'check_violation',
            HINT = 'Gmail files emails without a preheader as spam.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS newsletter_sends_require_preheader ON public.newsletter_sends;
CREATE TRIGGER newsletter_sends_require_preheader
  BEFORE INSERT ON public.newsletter_sends
  FOR EACH ROW EXECUTE FUNCTION public.newsletter_sends_require_preheader();
