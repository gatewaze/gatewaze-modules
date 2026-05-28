/**
 * Audit log writer (spec §11.3).
 *
 * Three entry points:
 *   - startTx(tx, …)          : insert "started" row inside the debit txn (§9.3 step 5)
 *   - finalizeByRequestId(id) : update by request_id (UPSERT-safe; idempotent retry)
 *   - writeBlocked(…)         : standalone insert for pre-debit policy blocks
 *                                (no debit, no ledger; status=403/415/429)
 *
 * Storage: raw URL is stored; redaction is read-time only (§11.3
 * canonical rule). truncated_request IS redacted at write time per the
 * §11.3 redaction spec.
 */

import type {
  AuditFinalizeInput,
  AuditStartInput,
  ModuleSettings,
} from './types.js';
import type { FetchInput } from './types.js';

// Caller-supplied DB client interface — kept generic so the module
// works with both supabase-js and a raw pg client.
export interface DbClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * Insert the "started" audit row inside the caller's debit transaction.
 * The caller MUST pass a transactional client; otherwise §9.3 step 5
 * atomicity is broken.
 */
export async function startTx(
  tx: DbClient,
  input: AuditStartInput,
): Promise<void> {
  await tx.query(
    `insert into fetch.audit_log (
       request_id, api_key_id, debit_id, fetched_at, surface,
       requested_url, url_host, mode, status,
       ignored_robots, user_agent_used, truncated_request
     ) values ($1, $2, $3, now(), $4, $5, $6, $7, -1, $8, $9, $10)`,
    [
      input.request_id,
      input.api_key_id,
      input.debit_id,
      input.surface,
      input.requested_url,
      input.url_host,
      input.mode,
      input.ignored_robots ?? false,
      input.user_agent_used ?? null,
      input.truncated_request ?? null,
    ],
  );
}

/**
 * Update the audit row identified by request_id with finalization fields.
 * Safe to retry: on retry the second UPDATE just rewrites the same fields.
 */
export async function finalizeByRequestId(
  db: DbClient,
  requestId: string,
  patch: AuditFinalizeInput,
): Promise<void> {
  // Build the SET clause dynamically so unset fields are left alone.
  const sets: string[] = [];
  const values: unknown[] = [requestId];
  let i = 2;
  const set = (col: string, val: unknown) => {
    sets.push(`${col} = $${i}`);
    values.push(val);
    i += 1;
  };
  if (patch.status !== undefined) set('status', patch.status);
  if (patch.duration_ms !== undefined) set('duration_ms', patch.duration_ms);
  if (patch.bytes_in !== undefined) set('bytes_in', patch.bytes_in);
  if (patch.bytes_out !== undefined) set('bytes_out', patch.bytes_out);
  if (patch.proxy_bytes !== undefined) set('proxy_bytes', patch.proxy_bytes);
  if (patch.browser_seconds !== undefined) set('browser_seconds', patch.browser_seconds);
  if (patch.final_url !== undefined) set('final_url', patch.final_url);
  if (patch.final_url_host !== undefined) set('final_url_host', patch.final_url_host);
  if (patch.redirect_chain !== undefined) {
    // Bounded to 10 hops; null when no redirects (per §5.3 representation).
    const rc = patch.redirect_chain;
    set('redirect_chain', rc && rc.length > 0 ? JSON.stringify(rc.slice(0, 10)) : null);
  }
  if (patch.blocked_by !== undefined) set('blocked_by', patch.blocked_by);
  if (patch.blocked_stage !== undefined) set('blocked_stage', patch.blocked_stage);
  if (patch.error_class !== undefined) set('error_class', patch.error_class);
  if (patch.cost_usd_estimate !== undefined) set('cost_usd_estimate', patch.cost_usd_estimate);
  if (patch.proxy_provider !== undefined) set('proxy_provider', patch.proxy_provider);

  if (sets.length === 0) return;
  await db.query(
    `update fetch.audit_log set ${sets.join(', ')} where request_id = $1`,
    values,
  );
}

/**
 * Insert a blocked audit row for a pre-debit policy block. No debit_id,
 * no ledger row. Used by §9.3 steps 3 (domain), 4 (robots), 5 (quota).
 */
export async function writeBlocked(
  db: DbClient,
  input: {
    request_id: string;
    api_key_id: string;
    requested_url: string;
    url_host: string;
    surface: 'rest' | 'mcp_stdio' | 'mcp_http';
    mode: 'fast' | 'stealth' | 'browser';
    blocked_by: import('./types.js').BlockedBy;
    blocked_stage: import('./types.js').BlockedStage;
    status: number;
    truncated_request?: Record<string, unknown> | null;
  },
): Promise<void> {
  await db.query(
    `insert into fetch.audit_log (
       request_id, api_key_id, fetched_at, surface,
       requested_url, url_host, mode, status,
       blocked_by, blocked_stage, truncated_request
     ) values ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.request_id,
      input.api_key_id,
      input.surface,
      input.requested_url,
      input.url_host,
      input.mode,
      input.status,
      input.blocked_by,
      input.blocked_stage,
      input.truncated_request ?? null,
    ],
  );
}

/**
 * Build the `truncated_request` JSON per §11.3 canonical redaction spec.
 *
 * Only stores the listed fields; query-parameter values matching
 * `redactKeys` are replaced with the literal string "REDACTED" (key
 * preserved for debugging context). Total payload hard-capped at 4 KiB.
 */
export function buildTruncatedRequest(
  input: FetchInput,
  redactKeys: string[],
): Record<string, unknown> {
  const lower = new Set(redactKeys.map(k => k.toLowerCase()));
  let urlForStorage: string;
  try {
    const u = new URL(input.url);
    for (const [k] of u.searchParams) {
      if (lower.has(k.toLowerCase())) u.searchParams.set(k, 'REDACTED');
    }
    urlForStorage = u.toString();
  } catch {
    urlForStorage = input.url;
  }
  const obj: Record<string, unknown> = {
    url: urlForStorage,
    mode: input.mode ?? 'fast',
    extract: input.extract ?? ['html'],
    timeout_ms: input.timeout_ms ?? 30_000,
    ignore_robots: input.ignore_robots ?? false,
    screenshot:
      input.screenshot === undefined
        ? false
        : input.screenshot === true
          ? true
          : input.screenshot === false
            ? false
            : 'options',
  };
  const json = JSON.stringify(obj);
  if (json.length > 4096) {
    return { _truncated: true };
  }
  return obj;
}

/**
 * Pull settings for redaction from the moduleConfig context.
 */
export function getRedactionKeys(settings: ModuleSettings): string[] {
  return settings.fetch_audit_redact_query_params ?? [];
}
