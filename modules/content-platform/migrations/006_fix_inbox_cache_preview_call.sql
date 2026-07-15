-- ============================================================================
-- content-platform — fix refresh_inbox_cache preview-function call
--
-- inbox_preview_fn is stored as a regprocedure; its ::text form includes the
-- argument list ("events_inbox_preview(uuid)"), so the dynamic SQL became
-- "SELECT ... FROM events_inbox_preview(uuid)($1)" — a syntax error caught by
-- the WARNING handler on every call. Inbox rows therefore never got cached
-- title/subtitle/thumbnail previews. Re-creates the function casting via
-- regproc to the bare callable name (fix also folded into 004 for fresh
-- installs).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.refresh_inbox_cache(
  p_content_type text,
  p_content_id   uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_adapter content_publish_adapters;
  v_sql text;
  v_row record;
BEGIN
  SELECT * INTO v_adapter FROM public.content_publish_adapters
    WHERE content_type = p_content_type;
  IF NOT FOUND OR v_adapter.inbox_preview_fn IS NULL THEN
    RETURN;
  END IF;

  -- inbox_preview_fn is a regprocedure whose text form carries the arg list
  -- ("events_inbox_preview(uuid)") — cast via regproc to get the bare
  -- callable name, else the format() below produces "fn(uuid)($1)".
  v_sql := format('SELECT title, subtitle, thumbnail_url FROM %s($1)',
                  v_adapter.inbox_preview_fn::oid::regproc::text);
  EXECUTE v_sql INTO v_row USING p_content_id;

  UPDATE public.content_triage_items
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'title', v_row.title,
      'subtitle', v_row.subtitle,
      'thumbnail_url', v_row.thumbnail_url,
      'preview_refreshed_at', now()
    )
    WHERE content_type = p_content_type
      AND content_id = p_content_id
      AND status IN ('pending','changes_requested');
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'refresh_inbox_cache failed for %.%: %', p_content_type, p_content_id, SQLERRM;
END $$;
ALTER FUNCTION public.refresh_inbox_cache(text, uuid) OWNER TO gatewaze_module_writer;
GRANT EXECUTE ON FUNCTION public.refresh_inbox_cache(text, uuid) TO service_role;
