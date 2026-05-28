/**
 * Validate & shape Netlify publisher secrets.
 */

import type { NetlifySecrets } from './types.js';

export interface ValidationFieldError {
  path: string;
  message: string;
}

export interface SecretsValidationResult {
  ok: boolean;
  errors: ReadonlyArray<ValidationFieldError>;
}

const TOKEN_MIN_LENGTH = 20;
// Netlify's site_id is a UUID with dashes (per their dashboard) OR a 24-char
// hex (legacy). Accept both shapes.
const SITE_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24})$/i;

export function validateSecrets(raw: unknown): SecretsValidationResult & { value?: NetlifySecrets } {
  const errors: ValidationFieldError[] = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: [{ path: '', message: 'must_be_object' }] };
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj['apiToken'] !== 'string' || obj['apiToken'].length < TOKEN_MIN_LENGTH) {
    errors.push({ path: 'apiToken', message: 'must_be_string_with_min_length' });
  }
  if (typeof obj['siteId'] !== 'string' || !SITE_ID_RE.test(obj['siteId'])) {
    errors.push({ path: 'siteId', message: 'must_be_uuid_or_24_hex' });
  }
  if (obj['teamSlug'] !== undefined && obj['teamSlug'] !== null) {
    if (typeof obj['teamSlug'] !== 'string' || obj['teamSlug'].length === 0) {
      errors.push({ path: 'teamSlug', message: 'must_be_non_empty_string' });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const out: NetlifySecrets = {
    apiToken: obj['apiToken'] as string,
    siteId: obj['siteId'] as string,
    ...(typeof obj['teamSlug'] === 'string' ? { teamSlug: obj['teamSlug'] } : {}),
  };
  return { ok: true, errors: [], value: out };
}
