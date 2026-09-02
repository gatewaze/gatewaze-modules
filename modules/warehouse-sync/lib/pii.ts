/**
 * PII field classification for column-level redaction (§8.2).
 *
 * When a table's config has `include_pii = false` (the default in non-production
 * / test destinations), the reconcile restricts the Airbyte stream to the
 * NON-PII columns via `selectedFields`, so personal data never leaves Supabase.
 * In production (`include_pii = true`) the full row is replicated — "exactly as
 * it is in Supabase".
 *
 * The classifier is name-pattern based and deliberately CONSERVATIVE: for a test
 * destination it is safer to over-redact a borderline column than to leak one.
 * Airbyte's change-data-capture metadata columns (`_ab_cdc_*`) and the stream's
 * primary key / cursor are always kept regardless (the connector requires them).
 */

/** Column-name fragments that mark a field as personal data. Matched case-insensitively. */
const PII_PATTERNS: RegExp[] = [
  /(^|_)e?mail(_|$)/, /consent_email/, /parental/,
  /phone|mobile|(^|_)fax|whatsapp/,
  /first_?name|last_?name|full_?name|given_?name|family_?name|middle_?name|maiden|nick_?name|display_?name|(^|_)name(_|$)/,
  /address|street|(^|_)city|postal|post_?code|(^|_)zip|county|jurisdiction/,
  /(^|_)dob(_|$)|birth|age(_|$)|gender|nationality/,
  /ssn|tax_?id|passport|national_?id|driver|licen[cs]e/,
  /ip_?address|(^|_)ip(_|$)|user_?agent|device_?id|fingerprint/,
  /lat(itude)?(_|$)|lon(g|gitude)?(_|$)|(^|_)geo|coordinates|timezone/,
  /avatar|gravatar|photo|picture|(^|_)image|headshot/,
  /linkedin|twitter|facebook|instagram|github|(^|_)url(_|$)|website|social|handle/,
  /(^|_)bio(_|$)|about|(^|_)notes?(_|$)|comment|(^|_)message|signature/,
];

/** True when a column name looks like personal data (and is not a CDC meta column). */
export function isPiiField(name: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith('_ab_cdc')) return false; // connector metadata, never redact
  return PII_PATTERNS.some((re) => re.test(n));
}

/**
 * Non-PII subset of a stream's fields, as Airbyte `selectedFields`. Always keeps
 * CDC metadata columns and the caller-supplied `keep` set (primary key + cursor),
 * which the connector rejects the request without.
 */
export function nonPiiSelectedFields(
  fields: string[],
  keep: Iterable<string> = [],
): { fieldPath: string[] }[] {
  const keepSet = new Set<string>();
  for (const k of keep) keepSet.add(k);
  return fields
    .filter((f) => f.toLowerCase().startsWith('_ab_cdc') || keepSet.has(f) || !isPiiField(f))
    .map((f) => ({ fieldPath: [f] }));
}
