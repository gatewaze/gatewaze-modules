-- ============================================================================
-- content-platform — universal category adapter + trigger.
-- See spec-unified-content-management.md §3.2, §8.9.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.content_category_adapters (
  content_type        text PRIMARY KEY,
  table_name          regclass NOT NULL,
  category_col        text NOT NULL DEFAULT 'content_category',
  member_value        text NOT NULL DEFAULT 'members',
  community_value     text NOT NULL DEFAULT 'community',
  auto_managed_values text[] NOT NULL DEFAULT ARRAY['members','community']::text[],
  registered_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.content_category_adapters OWNER TO gatewaze_module_writer;

-- ----------------------------------------------------------------------------
-- register_category_adapter — small helper modules call from migrations.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_category_adapter(
  p_content_type        text,
  p_table_name          regclass,
  p_category_col        text DEFAULT 'content_category',
  p_member_value        text DEFAULT 'members',
  p_community_value     text DEFAULT 'community',
  p_auto_managed_values text[] DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_col_type text;
  v_managed text[];
BEGIN
  SELECT format_type(atttypid, atttypmod) INTO v_col_type
    FROM pg_attribute
    WHERE attrelid = p_table_name::oid AND attname = p_category_col AND NOT attisdropped;
  IF v_col_type IS NULL THEN
    RAISE EXCEPTION 'table % missing category column %', p_table_name, p_category_col;
  END IF;

  v_managed := COALESCE(p_auto_managed_values, ARRAY[p_member_value, p_community_value]);

  INSERT INTO public.content_category_adapters
    (content_type, table_name, category_col, member_value, community_value, auto_managed_values)
  VALUES (p_content_type, p_table_name, p_category_col, p_member_value, p_community_value, v_managed)
  ON CONFLICT (content_type) DO UPDATE SET
    table_name          = EXCLUDED.table_name,
    category_col        = EXCLUDED.category_col,
    member_value        = EXCLUDED.member_value,
    community_value     = EXCLUDED.community_value,
    auto_managed_values = EXCLUDED.auto_managed_values;
END $$;
ALTER FUNCTION public.register_category_adapter(text, regclass, text, text, text, text[])
  OWNER TO gatewaze_module_writer;
GRANT EXECUTE ON FUNCTION public.register_category_adapter(text, regclass, text, text, text, text[]) TO service_role;

-- ----------------------------------------------------------------------------
-- Universal category-sync trigger. Fires on content_keyword_item_state writes
-- and propagates the verdict (member rule matched? → flip category) into the
-- registered content table.
--
-- Only overwrites the category if it's currently NULL or in the adapter's
-- auto_managed_values — preserving any manual override an admin set.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cm_category_sync_universal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_adapter content_category_adapters;
  v_has_member boolean;
  v_target text;
  v_sql text;
BEGIN
  SELECT * INTO v_adapter FROM public.content_category_adapters
    WHERE content_type = NEW.content_type;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.content_keyword_rules
    WHERE id = ANY(NEW.matched_rule_ids)
      AND metadata->>'kind' = 'membership'
  ) INTO v_has_member;

  v_target := CASE WHEN v_has_member THEN v_adapter.member_value ELSE v_adapter.community_value END;

  v_sql := format(
    'UPDATE %s SET %I = $1 WHERE id = $2 AND (%I IS NULL OR %I = ANY($3))',
    v_adapter.table_name,
    v_adapter.category_col,
    v_adapter.category_col,
    v_adapter.category_col
  );
  EXECUTE v_sql USING v_target, NEW.content_id, v_adapter.auto_managed_values;

  RETURN NEW;
END $$;
ALTER FUNCTION public.cm_category_sync_universal() OWNER TO gatewaze_module_writer;

-- Install the trigger on content_keyword_item_state. Soft-guarded.
DO $install$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_keyword_item_state'
  ) THEN
    EXECUTE 'DROP TRIGGER IF EXISTS cm_category_sync_universal_trg ON public.content_keyword_item_state';
    EXECUTE 'CREATE TRIGGER cm_category_sync_universal_trg
             AFTER INSERT OR UPDATE OF matched_rule_ids ON public.content_keyword_item_state
             FOR EACH ROW EXECUTE FUNCTION public.cm_category_sync_universal()';
  END IF;
END $install$;
