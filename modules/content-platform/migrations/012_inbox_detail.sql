-- ============================================================================
-- content-platform — inbox detail: what the reviewer needs to see the item
--
-- The Inbox drawer showed a title, an excerpt and the triage reasons, but no
-- way to read the thing being approved. For a discovered blog post that means
-- approving a post nobody has opened.
--
-- A content type can now register an optional `inbox_detail_fn`:
--
--   fn(p_id uuid) RETURNS TABLE(url text, image_url text, body_html text)
--
--   url        the original, for an "Open original" link (https only; the
--              API drops anything else)
--   image_url  the featured image
--   body_html  the stored body, already sanitised by whoever stored it; the
--              admin sanitises it again before rendering
--
-- content_inbox_detail() dispatches to it, the same way refresh_inbox_cache
-- dispatches to inbox_preview_fn. It is SECURITY DEFINER (owner
-- gatewaze_module_writer, which the adapters' RLS policies already admit)
-- and callable by service_role only: the admin API is the one caller, behind
-- requireAdmin. Idempotent.
-- ============================================================================

ALTER TABLE public.content_publish_adapters
  ADD COLUMN IF NOT EXISTS inbox_detail_fn regprocedure;

COMMENT ON COLUMN public.content_publish_adapters.inbox_detail_fn IS
  'Optional fn(uuid) RETURNS TABLE(url text, image_url text, body_html text) for the Inbox drawer preview.';

CREATE OR REPLACE FUNCTION public.content_inbox_detail(
  p_content_type text,
  p_content_id   uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_fn  regprocedure;
  v_out jsonb;
BEGIN
  SELECT inbox_detail_fn INTO v_fn FROM public.content_publish_adapters
    WHERE content_type = p_content_type;
  IF v_fn IS NULL THEN
    RETURN NULL;
  END IF;
  -- regprocedure text carries the argument list; go through regproc for the
  -- bare callable name (see 006_fix_inbox_cache_preview_call).
  EXECUTE format('SELECT to_jsonb(d) FROM %s($1) d LIMIT 1', v_fn::oid::regproc::text)
    INTO v_out USING p_content_id;
  RETURN v_out;
END $$;
ALTER FUNCTION public.content_inbox_detail(text, uuid) OWNER TO gatewaze_module_writer;

DO $acl$
BEGIN
  REVOKE ALL ON FUNCTION public.content_inbox_detail(text, uuid) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.content_inbox_detail(text, uuid) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.content_inbox_detail(text, uuid) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.content_inbox_detail(text, uuid) TO service_role;
  END IF;
END
$acl$;
