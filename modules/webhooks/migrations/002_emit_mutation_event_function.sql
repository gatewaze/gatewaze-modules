-- ============================================================================
-- Module: webhooks
-- Migration: 002_emit_mutation_event_function
-- Description: Shared trigger function attached to every subscribed table.
--              Data-driven via webhook_event_topics — adding a new module's
--              table requires only an INSERT into webhook_event_topics + a
--              CREATE TRIGGER ... emit_mutation_event() on the new table.
--              Per spec-api-cache-and-revalidation.md §4.4 (verbatim).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.emit_mutation_event() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_row_id uuid;
  v_host_id uuid;
  v_host_kind text;
  v_host_id_column text;
  v_notify_columns text[];
  v_op text;
  v_row_data jsonb := '{}'::jsonb;
  v_col text;
  v_val text;
  v_source record;
BEGIN
  v_op := lower(TG_OP);

  -- Look up topic config. Fast PK lookup; plan-cached per session.
  SELECT host_id_column, notify_columns
    INTO v_host_id_column, v_notify_columns
  FROM public.webhook_event_topics WHERE topic = TG_TABLE_NAME;

  -- Determine which row to read fields from.
  IF v_op = 'delete' THEN
    v_source := OLD;
    v_row_id := OLD.id;
  ELSE
    v_source := NEW;
    v_row_id := NEW.id;
  END IF;

  -- host_id resolution.
  IF v_host_id_column IS NULL THEN
    v_host_kind := 'global';
    v_host_id := '00000000-0000-0000-0000-000000000000';
  ELSE
    v_host_kind := 'site';
    EXECUTE format('SELECT ($1).%I', v_host_id_column) INTO v_host_id USING v_source;
  END IF;

  -- Materialise notify_columns into row_data. Capturing fields from
  -- OLD on DELETE is the ONLY way to get e.g. the row's slug into the
  -- payload before it's gone — the Hub can't re-query a deleted row.
  IF v_notify_columns IS NOT NULL THEN
    FOREACH v_col IN ARRAY v_notify_columns LOOP
      EXECUTE format('SELECT ($1).%I::text', v_col) INTO v_val USING v_source;
      v_row_data := jsonb_set(v_row_data, ARRAY[v_col], to_jsonb(v_val));
    END LOOP;
  END IF;

  -- pg_notify fires at TRANSACTION COMMIT, not at trigger time, even
  -- though the trigger row is AFTER INSERT/UPDATE/DELETE. Intentional:
  -- rolled-back transactions never leak events. Payload kept under
  -- the 8KB NOTIFY limit by emitting identifiers + the declared
  -- notify_columns only.
  PERFORM pg_notify(
    'gatewaze.mutation',
    json_build_object(
      'topic', TG_TABLE_NAME,
      'op', v_op,
      'row_id', v_row_id,
      'row', v_row_data,
      'host_kind', v_host_kind,
      'host_id', v_host_id,
      'ts', extract(epoch from now())
    )::text
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.emit_mutation_event() IS
  'AFTER INSERT/UPDATE/DELETE trigger function — emits pg_notify on gatewaze.mutation. Reads webhook_event_topics for per-table config. Per spec-api-cache-and-revalidation §4.4.';
