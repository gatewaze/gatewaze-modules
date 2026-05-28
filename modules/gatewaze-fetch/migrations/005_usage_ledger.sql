-- gatewaze-fetch — append-only usage ledger (spec §11.4 + §12.2.1).
--
-- The ledger is the BILLING SOURCE OF TRUTH. The fetch.quotas counter is
-- a fast cache for rate-limit decisions; the ledger is what's exported
-- for invoicing.
--
-- Canonical row shapes (§12.2.1) — all *_delta columns are 0 unless
-- noted:
--   kind='debit'      request_count_delta = +1
--                     browser_seconds_delta = +browser_seconds_estimate
--                     proxy_bytes_delta = 0  (estimate is 0; reconciled later)
--                     cost_usd_estimate_delta = +estimate_at_debit
--   kind='reconcile'  proxy_bytes_delta = +proxy_bytes_actual
--                     browser_seconds_delta = +(actual - reservation)
--                     cost_usd_estimate_delta = +delta
--   kind='refund'     request_count_delta = -1  (only requests refund)
--                     cost_usd_estimate_delta = -(per-request component)
--   kind='adjustment' operator-set values

create table if not exists fetch.usage_ledger (
  id text primary key,                            -- ULID = debit_id (for kind='debit')
  request_id text not null,                       -- joins to fetch.audit_log
  -- NOT NULL with default RESTRICT semantics: the FK blocks any
  -- hard-delete that would orphan ledger rows. This is the
  -- load-bearing referential-integrity guard for billing history
  -- (§11.3 deletion policy).
  api_key_id uuid not null references public.api_keys(id),
  occurred_at timestamptz not null default now(),
  kind text not null check (kind in ('debit','reconcile','refund','adjustment')),
  request_count_delta integer not null default 0,
  proxy_bytes_delta bigint not null default 0,
  browser_seconds_delta numeric(12,2) not null default 0,
  cost_usd_estimate_delta numeric(10,6) not null default 0,
  reason text,
  unique (request_id, kind)                       -- prevents double-refund on retry
);

create index if not exists idx_fetch_ledger_key_time
  on fetch.usage_ledger (api_key_id, occurred_at desc);
create index if not exists idx_fetch_ledger_request
  on fetch.usage_ledger (request_id);

-- Now that the ledger exists, complete the audit_log.debit_id FK.
-- (Deferred from migration 003 because audit_log is created before the
-- ledger table per the migration order.)
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'fk_fetch_audit_debit'
       and conrelid = 'fetch.audit_log'::regclass
  ) then
    alter table fetch.audit_log
      add constraint fk_fetch_audit_debit
      foreign key (debit_id)
      references fetch.usage_ledger(id)
      on delete set null;
  end if;
end $$;

-- Append-only enforcement.
-- The application connects as the platform's app role (whose name
-- varies by deployment shape: `gatewaze_app` in self-host k8s,
-- `authenticated` on Supabase cloud). REVOKE the mutating grants from
-- the known role names; deployment shapes that use a custom role set
-- the GUC `gatewaze.app_role_csv` (a single comma-separated string,
-- since Postgres GUCs are scalars) and the migration parses it.
do $$
declare
  csv text := current_setting('gatewaze.app_role_csv', true);
  r text;
begin
  if csv is not null and length(csv) > 0 then
    foreach r in array string_to_array(csv, ',')
    loop
      r := btrim(r);
      if r <> '' then
        execute format('revoke update, delete on fetch.usage_ledger from %I', r);
      end if;
    end loop;
  end if;
end $$;

-- Hard-coded REVOKE for the standard role names. These are always
-- applied; if a role doesn't exist in the deployment, Postgres reports
-- a notice (not an error) and migration continues.
do $$
begin
  begin
    revoke update, delete on fetch.usage_ledger from authenticated;
  exception when undefined_object then
    -- role doesn't exist; skip
    null;
  end;
  begin
    revoke update, delete on fetch.usage_ledger from anon;
  exception when undefined_object then
    null;
  end;
end $$;

-- Ownership posture (load-bearing): the table is owned by the
-- migration/admin role; the application role has only INSERT and
-- SELECT grants. The REVOKEs above are defense in depth — even if a
-- future grant accidentally adds update/delete back, the explicit
-- revoke takes precedence per Postgres grant semantics, but the
-- *primary* enforcement is never granting them in the first place.
--
-- RLS is intentionally NOT enabled on this table: the application uses
-- the migration role bypass model (per spec-public-api.md §4.1
-- conventions for service-tier writes).
