-- ============================================================================
-- luma module — let event deletion detach registration audit links
--
-- integrations_luma_pending_registrations.created_registration_id and
-- integrations_luma_event_registrations.created_registration_id both reference
-- events_registrations(id) with the default ON DELETE NO ACTION (RESTRICT).
--
-- Deleting an event cascades to its events_registrations rows (that FK is
-- ON DELETE CASCADE), but the cascade is BLOCKED by these RESTRICT links.
-- So any Luma-sourced event that produced a registration — notably the
-- auto-created "Luma Signup Events" from the reverse-signup flow, which set
-- created_registration_id when replaying a queued signup — cannot be deleted:
-- Postgres raises foreign_key_violation (23503) and the whole DELETE aborts.
--
-- created_registration_id is an audit back-reference, not ownership. Switch
-- both FKs to ON DELETE SET NULL so deleting an event detaches the audit rows
-- (preserving the inbound-email history) instead of being blocked.
--
-- Constraint names are discovered from the catalog rather than hard-coded:
-- the Postgres default name
--   integrations_luma_pending_registrations_created_registration_id_fkey
-- exceeds the 63-char identifier limit and is silently truncated, so a literal
-- DROP CONSTRAINT by that name would not match. Matching by (table, column,
-- referenced table) is also idempotent — re-running finds the SET NULL
-- constraint and re-applies it identically.
-- ============================================================================

DO $luma_reg_fk$
DECLARE
  v_tbl     text;
  v_conname text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'integrations_luma_pending_registrations',
    'integrations_luma_event_registrations'
  ] LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      CONTINUE;  -- table not present on this brand
    END IF;

    SELECT con.conname INTO v_conname
      FROM pg_constraint con
      JOIN pg_attribute att
        ON att.attrelid = con.conrelid
       AND att.attnum   = con.conkey[1]
     WHERE con.contype  = 'f'
       AND con.conrelid = ('public.' || v_tbl)::regclass
       AND con.confrelid = 'public.events_registrations'::regclass
       AND array_length(con.conkey, 1) = 1
       AND att.attname = 'created_registration_id';

    IF v_conname IS NULL THEN
      CONTINUE;  -- FK already dropped or never created
    END IF;

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_tbl, v_conname);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I '
      || 'FOREIGN KEY (created_registration_id) '
      || 'REFERENCES public.events_registrations(id) ON DELETE SET NULL',
      v_tbl, left(v_tbl || '_created_registration_id_fkey', 63)
    );
    RAISE NOTICE '[luma/004] %.created_registration_id FK -> ON DELETE SET NULL', v_tbl;
  END LOOP;
END $luma_reg_fk$;
