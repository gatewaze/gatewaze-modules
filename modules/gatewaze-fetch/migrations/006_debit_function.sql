-- gatewaze-fetch — atomic debit + ledger + audit-start function (spec §9.3 step 5).
--
-- Wraps the three-write transaction in a single server-side function so
-- atomicity is guaranteed without depending on the application layer to
-- run a transaction correctly. Returns either the committed debit_id or
-- a sentinel indicating which dimension failed.

create or replace function fetch.debit_and_start(
  p_api_key_id    uuid,
  p_request_id    text,
  p_debit_id      text,
  p_surface       text,
  p_requested_url text,
  p_url_host      text,
  p_mode          text,
  p_ignored_robots boolean,
  p_user_agent_used text,
  p_truncated_request jsonb,
  p_requests_limit  integer,
  p_browser_seconds_limit numeric,
  p_proxy_bytes_limit bigint,
  p_browser_seconds_estimate numeric,
  p_cost_usd_estimate numeric
) returns jsonb
language plpgsql
as $$
declare
  v_period_start timestamptz;
  v_period_end   timestamptz;
  v_now timestamptz := now();
  v_updated_count int;
  v_existing_period_end timestamptz;
begin
  -- Compute calendar-month bounds in UTC.
  v_period_start := date_trunc('month', v_now at time zone 'UTC') at time zone 'UTC';
  v_period_end   := (date_trunc('month', v_now at time zone 'UTC') + interval '1 month') at time zone 'UTC';

  -- Lazy-create row if absent.
  insert into fetch.quotas (
    api_key_id, period_start, period_end,
    requests_limit, browser_seconds_limit, proxy_bytes_limit,
    requests_used, browser_seconds_used, proxy_bytes_used,
    updated_at
  ) values (
    p_api_key_id, v_period_start, v_period_end,
    p_requests_limit, p_browser_seconds_limit, p_proxy_bytes_limit,
    0, 0, 0, v_now
  )
  on conflict (api_key_id) do nothing;

  -- Roll the period if the row is for an older calendar month.
  select period_end into v_existing_period_end
    from fetch.quotas where api_key_id = p_api_key_id
    for update;
  if v_existing_period_end <= v_now then
    update fetch.quotas
       set period_start = v_period_start,
           period_end   = v_period_end,
           requests_used = 0,
           browser_seconds_used = 0,
           proxy_bytes_used = 0,
           requests_limit = p_requests_limit,
           browser_seconds_limit = p_browser_seconds_limit,
           proxy_bytes_limit = p_proxy_bytes_limit,
           updated_at = v_now
     where api_key_id = p_api_key_id;
  end if;

  -- Atomic debit guarded by request and browser-seconds bounds.
  -- Proxy bytes are NOT pre-bounded (estimate is 0; reconciled later).
  update fetch.quotas
     set requests_used = requests_used + 1,
         browser_seconds_used = browser_seconds_used + p_browser_seconds_estimate,
         updated_at = v_now
   where api_key_id = p_api_key_id
     and requests_used + 1 <= requests_limit
     and (browser_seconds_used + p_browser_seconds_estimate) <= browser_seconds_limit;
  get diagnostics v_updated_count = row_count;

  if v_updated_count = 0 then
    -- Determine which dimension failed (best effort).
    declare
      v_req_used int;
      v_req_limit int;
      v_bs_used numeric;
      v_bs_limit numeric;
      v_dim text;
    begin
      select requests_used, requests_limit,
             browser_seconds_used, browser_seconds_limit
        into v_req_used, v_req_limit, v_bs_used, v_bs_limit
        from fetch.quotas where api_key_id = p_api_key_id;
      if v_req_used + 1 > v_req_limit then
        v_dim := 'requests';
      elsif v_bs_used + p_browser_seconds_estimate > v_bs_limit then
        v_dim := 'browser_seconds';
      else
        v_dim := 'unknown';
      end if;
      return jsonb_build_object('ok', false, 'dimension', v_dim);
    end;
  end if;

  -- Insert the kind='debit' ledger row.
  insert into fetch.usage_ledger (
    id, request_id, api_key_id, kind,
    request_count_delta, browser_seconds_delta, proxy_bytes_delta,
    cost_usd_estimate_delta, reason
  ) values (
    p_debit_id, p_request_id, p_api_key_id, 'debit',
    1, p_browser_seconds_estimate, 0,
    p_cost_usd_estimate, 'debit:' || p_mode
  );

  -- Insert the audit "started" row in the same transaction.
  insert into fetch.audit_log (
    request_id, api_key_id, debit_id, fetched_at, surface,
    requested_url, url_host, mode, status,
    ignored_robots, user_agent_used, truncated_request
  ) values (
    p_request_id, p_api_key_id, p_debit_id, v_now, p_surface,
    p_requested_url, p_url_host, p_mode, -1,
    coalesce(p_ignored_robots, false), p_user_agent_used, p_truncated_request
  );

  return jsonb_build_object('ok', true, 'debit_id', p_debit_id);
end $$;

-- Allow the application role to call the function. We don't need
-- granular grants — the function is SECURITY INVOKER (default) so
-- calls inherit the caller's privileges, but the function itself
-- encapsulates the multi-table writes that would otherwise need to
-- be threaded through a transactional client.
grant execute on function fetch.debit_and_start(
  uuid, text, text, text, text, text, text, boolean,
  text, jsonb, integer, numeric, bigint, numeric, numeric
) to public;
