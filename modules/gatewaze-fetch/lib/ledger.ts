/**
 * Append-only usage ledger writer (spec §11.4, §12.2.1).
 *
 * Writes `kind='debit' | 'reconcile' | 'refund' | 'adjustment'` rows.
 * `(request_id, kind)` is unique — `INSERT … ON CONFLICT DO NOTHING`
 * makes refund/reconcile idempotent on retry.
 *
 * The ledger is the BILLING SOURCE OF TRUTH; `fetch.quotas` is a fast
 * counter cache that's reconciled nightly.
 */

import type { DbClient } from './audit.js';

export interface LedgerInsertInput {
  id: string; // ULID; for kind='debit' this is the debit_id
  request_id: string;
  api_key_id: string;
  request_count_delta?: number;
  proxy_bytes_delta?: number;
  browser_seconds_delta?: number;
  cost_usd_estimate_delta?: number;
  reason?: string;
}

/**
 * Insert a kind='debit' row inside the caller's debit transaction.
 * Returns the row's id (which the caller passes as audit.debit_id).
 */
export async function insertDebitTx(
  tx: DbClient,
  input: LedgerInsertInput,
): Promise<string> {
  await tx.query(
    `insert into fetch.usage_ledger (
       id, request_id, api_key_id, kind,
       request_count_delta, browser_seconds_delta, proxy_bytes_delta,
       cost_usd_estimate_delta, reason
     ) values ($1, $2, $3, 'debit', $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.request_id,
      input.api_key_id,
      input.request_count_delta ?? 0,
      input.browser_seconds_delta ?? 0,
      input.proxy_bytes_delta ?? 0,
      input.cost_usd_estimate_delta ?? 0,
      input.reason ?? 'debit',
    ],
  );
  return input.id;
}

/**
 * Insert a kind='reconcile' row when actual values differ from the
 * pre-debit estimate (spec §9.2.2). Idempotent on (request_id, kind).
 */
export async function insertReconcile(
  db: DbClient,
  input: Omit<LedgerInsertInput, 'request_count_delta'>,
): Promise<void> {
  await db.query(
    `insert into fetch.usage_ledger (
       id, request_id, api_key_id, kind,
       request_count_delta, browser_seconds_delta, proxy_bytes_delta,
       cost_usd_estimate_delta, reason
     ) values ($1, $2, $3, 'reconcile', 0, $4, $5, $6, $7)
     on conflict (request_id, kind) do nothing`,
    [
      input.id,
      input.request_id,
      input.api_key_id,
      input.browser_seconds_delta ?? 0,
      input.proxy_bytes_delta ?? 0,
      input.cost_usd_estimate_delta ?? 0,
      input.reason ?? 'reconcile',
    ],
  );
}

/**
 * Insert a kind='refund' row. Only `request_count` is refunded
 * (browser_seconds and proxy_bytes already spent stay debited).
 * Idempotent on (request_id, kind).
 */
export async function insertRefund(
  db: DbClient,
  input: {
    id: string;
    request_id: string;
    api_key_id: string;
    cost_usd_per_request_estimate?: number;
    reason: string; // e.g. 'final_url_blocked', 'unsupported_media_type', 'upstream_504'
  },
): Promise<void> {
  await db.query(
    `insert into fetch.usage_ledger (
       id, request_id, api_key_id, kind,
       request_count_delta, browser_seconds_delta, proxy_bytes_delta,
       cost_usd_estimate_delta, reason
     ) values ($1, $2, $3, 'refund', -1, 0, 0, $4, $5)
     on conflict (request_id, kind) do nothing`,
    [
      input.id,
      input.request_id,
      input.api_key_id,
      -(input.cost_usd_per_request_estimate ?? 0),
      input.reason,
    ],
  );
  // Mirror the requests refund into fetch.quotas so the counter
  // matches the ledger immediately. Reconciliation jobs pick up any
  // mismatch nightly.
  await db.query(
    `update fetch.quotas set requests_used = greatest(0, requests_used - 1) where api_key_id = $1`,
    [input.api_key_id],
  );
}

/**
 * Generate a fresh ULID. We don't pull in the `ulid` package to keep
 * the module dependency footprint small — this implementation matches
 * the ULID spec (Crockford base32, 48-bit timestamp + 80 bits random).
 */
export function newUlid(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { randomBytes } = require('node:crypto');
  const ts = Date.now();
  const tsBuf = Buffer.alloc(6);
  // big-endian 48-bit
  tsBuf.writeUIntBE(ts, 0, 6);
  const rand = randomBytes(10);
  const all = Buffer.concat([tsBuf, rand]);
  return crockford(all);
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function crockford(buf: Buffer): string {
  // 16 bytes -> 26 base32 chars (130 bits, top 2 bits will be 0).
  let result = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += ALPHABET[(value >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    result += ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  // Pad to 26 chars (ULID standard); leading zero on the timestamp side.
  return result.padStart(26, '0');
}
