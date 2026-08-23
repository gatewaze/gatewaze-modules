/**
 * The canonical taxonomy for test-environment observability events — ONE
 * source of truth shared by the API (summary aggregation in
 * lib/env-events-query.ts) and the admin log explorer
 * (admin/components/envLog.ts + EnvLogExplorer.tsx). Keeping it here stops the
 * two sides drifting into disagreeing about what counts as an error.
 *
 * The kinds below are exactly what the host-side writers emit today:
 *   - scripts/staging-multienv.sh + lib-lfx-env.sh (env_event):
 *       create · ready · fail · reap · reap_refused · teardown ·
 *       teardown_refused · admission_refused · root_promote · root_demote ·
 *       root_demote_fallback · root_reassert · root_boot_restore ·
 *       root_alias_failed
 *   - scripts/staging-provisioner.py: provision
 *   - scripts/staging-prview-tailer.sh: visit · login_success · login_failure ·
 *       service_error
 *
 * An UNKNOWN kind is a first-class case, not a bug: migration 025 deliberately
 * leaves `kind` unconstrained so a newer host agent can emit a new kind before
 * the module knows about it. Everything here degrades to a sane default
 * ('lifecycle' / 'info') rather than dropping the row.
 */

/** Filter grouping shown as the top-level chips in the explorer. */
export type EventCategory = 'lifecycle' | 'access' | 'error';
/** Row treatment: colour, icon, and whether the summary strip shouts. */
export type EventSeverity = 'error' | 'warn' | 'ok' | 'info' | 'muted';

export interface EventKindSpec {
  category: EventCategory;
  severity: EventSeverity;
  /** Human label for the row badge (kinds are snake_case machine names). */
  label: string;
  /** Plural noun for a collapsed run ("42 visits"). Defaults to label + 's'. */
  plural?: string;
}

export const EVENT_KINDS: Record<string, EventKindSpec> = {
  // ── lifecycle ──────────────────────────────────────────────────────────────
  provision: { category: 'lifecycle', severity: 'info', label: 'provision' },
  create: { category: 'lifecycle', severity: 'info', label: 'create' },
  ready: { category: 'lifecycle', severity: 'ok', label: 'ready' },
  fail: { category: 'lifecycle', severity: 'error', label: 'fail' },
  reap: { category: 'lifecycle', severity: 'warn', label: 'reap' },
  reap_refused: { category: 'lifecycle', severity: 'warn', label: 'reap refused' },
  teardown: { category: 'lifecycle', severity: 'info', label: 'teardown' },
  teardown_refused: { category: 'lifecycle', severity: 'warn', label: 'teardown refused' },
  admission_refused: { category: 'lifecycle', severity: 'warn', label: 'admission refused' },
  root_promote: { category: 'lifecycle', severity: 'info', label: 'root promote' },
  root_demote: { category: 'lifecycle', severity: 'info', label: 'root demote' },
  root_demote_fallback: { category: 'lifecycle', severity: 'error', label: 'root demote (fallback)' },
  root_reassert: { category: 'lifecycle', severity: 'info', label: 'root reassert', plural: 'root reasserts' },
  root_boot_restore: { category: 'lifecycle', severity: 'ok', label: 'root restored' },
  // A displaced primary could not be reached at its lfx--main.pr-view.com alias:
  // the URL a human was told to use is dead. Error severity, so it lands in the
  // Errors group and the summary strip's shouting count — the same treatment as
  // root_demote_fallback, and the reason this needs registering at all (an
  // unknown kind degrades to lifecycle/info, which reads as benign).
  root_alias_failed: {
    category: 'lifecycle',
    severity: 'error',
    label: 'root alias failed',
    plural: 'root alias failures',
  },
  // ── access ─────────────────────────────────────────────────────────────────
  visit: { category: 'access', severity: 'muted', label: 'visit', plural: 'visits' },
  login_success: { category: 'access', severity: 'ok', label: 'login', plural: 'logins' },
  login_failure: { category: 'access', severity: 'error', label: 'login failed', plural: 'failed logins' },
  // ── errors ─────────────────────────────────────────────────────────────────
  service_error: { category: 'error', severity: 'error', label: 'service error', plural: 'service errors' },
};

const UNKNOWN: EventKindSpec = { category: 'lifecycle', severity: 'info', label: 'event' };

export const kindSpec = (kind: string): EventKindSpec => EVENT_KINDS[kind] ?? UNKNOWN;
export const kindCategory = (kind: string): EventCategory => kindSpec(kind).category;
export const kindSeverity = (kind: string): EventSeverity => kindSpec(kind).severity;
export const kindLabel = (kind: string): string => EVENT_KINDS[kind]?.label ?? kind.replace(/_/g, ' ');
/** Plural form for a collapsed run of `n` events of this kind. */
export const kindCount = (kind: string, n: number): string =>
  `${n} ${n === 1 ? kindLabel(kind) : (EVENT_KINDS[kind]?.plural ?? `${kindLabel(kind)}s`)}`;

const kindsWhere = (pred: (s: EventKindSpec) => boolean): string[] =>
  Object.keys(EVENT_KINDS).filter((k) => pred(EVENT_KINDS[k]));

/**
 * Refusals: not failures, but the answer to "why did my env not come up / not
 * go away", so they belong in the Errors view next to the hard failures. A
 * plain `reap` is a normal TTL expiry and stays out of it (it is amber in the
 * row list, but it is not something to triage).
 */
export const REFUSAL_KINDS = ['admission_refused', 'teardown_refused', 'reap_refused'] as const;

/**
 * The three filter groups. `errors` is severity-derived (everything red) plus
 * the refusals above; the other two are exactly their category.
 */
export const KIND_GROUPS: Record<'lifecycle' | 'access' | 'errors', string[]> = {
  lifecycle: kindsWhere((s) => s.category === 'lifecycle'),
  access: kindsWhere((s) => s.category === 'access'),
  errors: [...new Set([...kindsWhere((s) => s.severity === 'error'), ...REFUSAL_KINDS])],
};

/** True when a kind should be counted in the summary strip's shouting number. */
export const isErrorKind = (kind: string): boolean => kindSeverity(kind) === 'error';

/** Shape a kind must satisfy to be accepted as a filter value (mirrors the ingester). */
export const KIND_RE = /^[a-z][a-z0-9_]{0,31}$/;
