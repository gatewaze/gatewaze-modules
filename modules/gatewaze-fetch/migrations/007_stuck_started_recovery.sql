-- gatewaze-fetch — stuck-`status=-1` recovery (spec §9.6.1).
--
-- Scans audit rows that started but never finalized (process crash
-- between debit and finalize). For each:
--   1. Inserts a kind='adjustment' ledger row crediting the reserved
--      browser-seconds back to the key.
--   2. Updates the audit row to status=599 (synthetic recovery
--      marker), error_class='internal_error'.
--   3. Returns the count of rows recovered.
--
-- Operators schedule this with pg_cron (cloud Supabase) or a systemd
-- timer (self-host) calling SELECT gw_fetch.recover_stuck_started(); —
-- typical schedule: hourly. The 1-hour floor on fetched_at avoids
-- racing legitimately long browser fetches.

create or replace function gw_fetch.recover_stuck_started(
  recovery_age_seconds int default 3600
) returns int
language plpgsql as $$
declare
  victim record;
  total_recovered int := 0;
  v_browser_seconds_estimate numeric;
begin
  for victim in
    select request_id, api_key_id, debit_id, mode
      from gw_fetch.audit_log
     where status = -1
       and fetched_at < now() - make_interval(secs => recovery_age_seconds)
     for update skip locked
  loop
    -- Refund the browser_seconds reservation (proxy_bytes had no
    -- pre-debit reservation — estimate was 0, so no refund needed).
    select case when mode = 'browser' then 60 else 0 end
      into v_browser_seconds_estimate;

    if victim.debit_id is not null then
      insert into gw_fetch.usage_ledger (
        id, request_id, api_key_id, kind,
        request_count_delta, browser_seconds_delta, proxy_bytes_delta,
        cost_usd_estimate_delta, reason
      ) values (
        gen_random_uuid()::text,
        victim.request_id,
        victim.api_key_id,
        'adjustment',
        0,
        -v_browser_seconds_estimate,
        0,
        0,
        'stuck_started_recovery'
      ) on conflict (request_id, kind) do nothing;

      -- Mirror into gw_fetch.quotas counter.
      update gw_fetch.quotas
         set browser_seconds_used = greatest(0, browser_seconds_used - v_browser_seconds_estimate)
       where api_key_id = victim.api_key_id;
    end if;

    -- Mark the audit row recovered (synthetic status 599 + error_class).
    update gw_fetch.audit_log
       set status = 599,
           error_class = 'internal_error',
           blocked_by = null
     where request_id = victim.request_id
       and status = -1;

    total_recovered := total_recovered + 1;
  end loop;
  return total_recovered;
end $$;
