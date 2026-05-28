/**
 * Lightweight DB helpers that wrap the supabase service-role client.
 *
 * The lib/audit, lib/ledger, and lib/robots modules speak the generic
 * `DbClient` interface (`{ query: (sql, values) => Promise<{ rows }> }`)
 * for portability. Gatewaze runs on Supabase, which doesn't expose
 * arbitrary SQL via PostgREST — we use `supabase.rpc()` for the debit
 * transaction (encapsulated in migration 006) and `supabase.from(...)`
 * for the rest.
 *
 * For Phase 2 vertical slice, we accept the architectural compromise:
 * domain rules and quota state are read via PostgREST `.from()`; the
 * one transactional write goes via `rpc('debit_and_start', ...)`. The
 * audit/ledger writes called from the lib helpers (with the generic
 * DbClient interface) are emulated via per-statement PostgREST writes
 * using the helpers in this file, NOT via the generic adapter — the
 * adapter exists for unit tests and a future pg-based deployment.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AuditFinalizeInput,
  BlockedBy,
  BlockedStage,
  FetchMode,
  RedirectHop,
  Surface,
} from './types.js';

export interface DomainRulesSnapshot {
  instanceDeny: string[];
  instanceAllow: string[];
  keyDeny: string[];
  keyAllow: string[];
  version: number;
}

/**
 * Read all domain rules for an API key in one round-trip. We
 * deliberately do NOT cache this — domain rule changes take effect on
 * the next request (§7.5).
 */
export async function readDomainRules(
  supabase: SupabaseClient,
  apiKeyId: string,
): Promise<DomainRulesSnapshot> {
  // Three queries (instance rules, key rules, version) — fired in
  // parallel.
  const [instanceQ, keyQ, verQ] = await Promise.all([
    supabase
      .schema('fetch')
      .from('instance_domain_rules')
      .select('list_kind, pattern'),
    supabase
      .schema('fetch')
      .from('key_domain_rules')
      .select('list_kind, pattern')
      .eq('api_key_id', apiKeyId),
    supabase.schema('fetch').from('domain_rules_version').select('version').single(),
  ]);

  const instanceDeny: string[] = [];
  const instanceAllow: string[] = [];
  for (const r of instanceQ.data ?? []) {
    if (r.list_kind === 'deny') instanceDeny.push(r.pattern);
    else instanceAllow.push(r.pattern);
  }
  const keyDeny: string[] = [];
  const keyAllow: string[] = [];
  for (const r of keyQ.data ?? []) {
    if (r.list_kind === 'deny') keyDeny.push(r.pattern);
    else keyAllow.push(r.pattern);
  }
  return {
    instanceDeny,
    instanceAllow,
    keyDeny,
    keyAllow,
    version: (verQ.data as { version?: number } | null)?.version ?? 0,
  };
}

export interface DebitAndStartArgs {
  apiKeyId: string;
  requestId: string;
  debitId: string;
  surface: Surface;
  requestedUrl: string;
  urlHost: string;
  mode: FetchMode;
  ignoredRobots: boolean;
  userAgentUsed: string | null;
  truncatedRequest: Record<string, unknown> | null;
  requestsLimit: number;
  browserSecondsLimit: number;
  proxyBytesLimit: number;
  browserSecondsEstimate: number;
  costUsdEstimate: number;
}

export type DebitAndStartResult =
  | { ok: true; debit_id: string }
  | { ok: false; dimension: 'requests' | 'browser_seconds' | 'proxy_bytes' | 'unknown' };

/**
 * Call the migration-006 function. One round-trip, atomic transaction
 * server-side.
 */
export async function debitAndStart(
  supabase: SupabaseClient,
  args: DebitAndStartArgs,
): Promise<DebitAndStartResult> {
  const { data, error } = await supabase.schema('fetch').rpc('debit_and_start', {
    p_api_key_id: args.apiKeyId,
    p_request_id: args.requestId,
    p_debit_id: args.debitId,
    p_surface: args.surface,
    p_requested_url: args.requestedUrl,
    p_url_host: args.urlHost,
    p_mode: args.mode,
    p_ignored_robots: args.ignoredRobots,
    p_user_agent_used: args.userAgentUsed,
    p_truncated_request: args.truncatedRequest,
    p_requests_limit: args.requestsLimit,
    p_browser_seconds_limit: args.browserSecondsLimit,
    p_proxy_bytes_limit: args.proxyBytesLimit,
    p_browser_seconds_estimate: args.browserSecondsEstimate,
    p_cost_usd_estimate: args.costUsdEstimate,
  });
  if (error) throw new Error(`debit_and_start failed: ${error.message}`);
  return data as DebitAndStartResult;
}

/**
 * Insert a blocked audit row outside any transaction (pre-debit policy
 * blocks: domain, robots, quota — §9.3 steps 3, 4, 5).
 */
export async function writeBlockedAuditRow(
  supabase: SupabaseClient,
  input: {
    requestId: string;
    apiKeyId: string;
    surface: Surface;
    requestedUrl: string;
    urlHost: string;
    mode: FetchMode;
    blockedBy: BlockedBy;
    blockedStage: BlockedStage;
    status: number;
    truncatedRequest: Record<string, unknown> | null;
  },
): Promise<void> {
  await supabase.schema('fetch').from('audit_log').insert({
    request_id: input.requestId,
    api_key_id: input.apiKeyId,
    surface: input.surface,
    requested_url: input.requestedUrl,
    url_host: input.urlHost,
    mode: input.mode,
    status: input.status,
    blocked_by: input.blockedBy,
    blocked_stage: input.blockedStage,
    truncated_request: input.truncatedRequest,
  });
}

/**
 * UPDATE-by-request_id audit finalization. Idempotent — safe to retry.
 */
export async function finalizeAuditRow(
  supabase: SupabaseClient,
  requestId: string,
  patch: AuditFinalizeInput,
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.duration_ms !== undefined) update.duration_ms = patch.duration_ms;
  if (patch.bytes_in !== undefined) update.bytes_in = patch.bytes_in;
  if (patch.bytes_out !== undefined) update.bytes_out = patch.bytes_out;
  if (patch.proxy_bytes !== undefined) update.proxy_bytes = patch.proxy_bytes;
  if (patch.browser_seconds !== undefined) update.browser_seconds = patch.browser_seconds;
  if (patch.final_url !== undefined) update.final_url = patch.final_url;
  if (patch.final_url_host !== undefined) update.final_url_host = patch.final_url_host;
  if (patch.redirect_chain !== undefined) {
    const rc: RedirectHop[] | null | undefined = patch.redirect_chain;
    update.redirect_chain = rc && rc.length > 0 ? rc.slice(0, 10) : null;
  }
  if (patch.blocked_by !== undefined) update.blocked_by = patch.blocked_by;
  if (patch.blocked_stage !== undefined) update.blocked_stage = patch.blocked_stage;
  if (patch.error_class !== undefined) update.error_class = patch.error_class;
  if (patch.cost_usd_estimate !== undefined) update.cost_usd_estimate = patch.cost_usd_estimate;
  if (patch.proxy_provider !== undefined) update.proxy_provider = patch.proxy_provider;
  if (Object.keys(update).length === 0) return;
  await supabase
    .schema('fetch')
    .from('audit_log')
    .update(update)
    .eq('request_id', requestId);
}

/**
 * Reconcile actual usage against the pre-debit estimates (§9.2.2).
 * Always applies the delta; a positive delta that pushes proxy_bytes
 * over limit doesn't fail — the request is already complete. Future
 * requests will hit 429 QUOTA_EXHAUSTED.
 *
 * Also writes a kind='reconcile' ledger row when delta is non-zero.
 */
export async function reconcileQuotaAndLedger(
  supabase: SupabaseClient,
  args: {
    apiKeyId: string;
    requestId: string;
    ledgerId: string;
    browserSecondsDelta: number;
    proxyBytesDelta: number;
    costUsdDelta: number;
  },
): Promise<void> {
  // Apply the quota delta directly. Supabase doesn't have an "increment
  // by N" syntax via PostgREST; we use a small RPC. To keep this Phase
  // 2 vertical slice contained, we use a SELECT-then-UPDATE pattern
  // (race-tolerable for reconcile because the §9.7 nightly job catches
  // any drift; the per-request runtime drift check at every 1000th
  // request also catches it sooner).
  const { data: cur } = await supabase
    .schema('fetch')
    .from('quotas')
    .select('browser_seconds_used, proxy_bytes_used')
    .eq('api_key_id', args.apiKeyId)
    .single();
  if (cur) {
    await supabase
      .schema('fetch')
      .from('quotas')
      .update({
        browser_seconds_used: Number(cur.browser_seconds_used) + args.browserSecondsDelta,
        proxy_bytes_used: Number(cur.proxy_bytes_used) + args.proxyBytesDelta,
      })
      .eq('api_key_id', args.apiKeyId);
  }

  if (args.browserSecondsDelta !== 0 || args.proxyBytesDelta !== 0) {
    await supabase
      .schema('fetch')
      .from('usage_ledger')
      .upsert(
        {
          id: args.ledgerId,
          request_id: args.requestId,
          api_key_id: args.apiKeyId,
          kind: 'reconcile',
          request_count_delta: 0,
          browser_seconds_delta: args.browserSecondsDelta,
          proxy_bytes_delta: args.proxyBytesDelta,
          cost_usd_estimate_delta: args.costUsdDelta,
          reason: `reconcile:${args.requestId}`,
        },
        { onConflict: 'request_id,kind', ignoreDuplicates: true },
      );
  }
}
