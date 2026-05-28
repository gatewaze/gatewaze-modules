/**
 * Validate & shape Cloudflare publisher secrets.
 *
 * Pure: returns a structured ValidationResult so the platform can surface
 * field-level errors in the admin UI before the worker is queued.
 */

import type { CloudflareSecrets } from './types.js';

export interface ValidationFieldError {
  path: string;
  message: string;
}

export interface SecretsValidationResult {
  ok: boolean;
  errors: ReadonlyArray<ValidationFieldError>;
}

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
const ZONE_ID_RE = /^[0-9a-f]{32}$/;
const PROJECT_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;
const TOKEN_MIN_LENGTH = 20;

/**
 * Validate & narrow Cloudflare secrets. Returns the typed CloudflareSecrets
 * on success or a SecretsValidationResult with field errors on failure.
 */
export function validateSecrets(raw: unknown): SecretsValidationResult & { value?: CloudflareSecrets } {
  const errors: ValidationFieldError[] = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: [{ path: '', message: 'must_be_object' }] };
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj['apiToken'] !== 'string' || obj['apiToken'].length < TOKEN_MIN_LENGTH) {
    errors.push({ path: 'apiToken', message: 'must_be_string_with_min_length' });
  }
  if (typeof obj['accountId'] !== 'string' || !ACCOUNT_ID_RE.test(obj['accountId'])) {
    errors.push({ path: 'accountId', message: 'must_be_32_hex' });
  }
  if (typeof obj['projectName'] !== 'string' || !PROJECT_NAME_RE.test(obj['projectName'])) {
    errors.push({ path: 'projectName', message: 'must_be_valid_pages_project_slug' });
  }
  if (obj['zoneId'] !== undefined && obj['zoneId'] !== null) {
    if (typeof obj['zoneId'] !== 'string' || !ZONE_ID_RE.test(obj['zoneId'])) {
      errors.push({ path: 'zoneId', message: 'must_be_32_hex' });
    }
  }
  if (obj['productionBranch'] !== undefined && obj['productionBranch'] !== null) {
    if (typeof obj['productionBranch'] !== 'string' || obj['productionBranch'].length === 0) {
      errors.push({ path: 'productionBranch', message: 'must_be_non_empty_string' });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const out: CloudflareSecrets = {
    apiToken: obj['apiToken'] as string,
    accountId: obj['accountId'] as string,
    projectName: obj['projectName'] as string,
    ...(typeof obj['zoneId'] === 'string' ? { zoneId: obj['zoneId'] } : {}),
    ...(typeof obj['productionBranch'] === 'string' ? { productionBranch: obj['productionBranch'] } : {}),
  };
  return { ok: true, errors: [], value: out };
}
