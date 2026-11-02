/**
 * Module settings from installed_modules.config, with safe defaults. Every
 * number is clamped so a typo cannot make the worker run for an hour or spend
 * a month of credits in a day.
 */

export const PROVIDER_PREFIX = 'email-verification-';
const PROVIDER_ID_RE = /^email-verification-[a-z0-9][a-z0-9-]{0,40}$/;

export interface VerificationConfig {
  /** Check an address again after this many days. */
  recheckDays: number;
  /** Most addresses checked per worker run. */
  checksPerRun: number;
  /** Each worker run stops after this long. */
  budgetMs: number;
  /** Most paid checks per day across all providers. 0 turns paid checks off. */
  dailyPaidLimit: number;
  /** Provider module ids, first choice first. Empty means every enabled provider, by id. */
  providerOrder: string[];
  /** Provider asked again about catch-all and unknown results. */
  escalationProvider: string | null;
  /** Provider run alongside on a sample, to compare answers. Never changes a result. */
  compareProvider: string | null;
  /** Share of checked addresses also sent to the compare provider, 0 to 100. */
  comparePercent: number;
  /** Add invalid addresses to broadcast suppressions so broadcasts skip them. */
  suppressInvalid: boolean;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

/** 'debounce' or 'email-verification-debounce' to the module id, or null when it is not a valid id. */
export function providerId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  const id = s.startsWith(PROVIDER_PREFIX) ? s : PROVIDER_PREFIX + s;
  return PROVIDER_ID_RE.test(id) ? id : null;
}

function idList(v: unknown): string[] {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out: string[] = [];
  for (const p of parts) {
    const id = providerId(p);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export function parseConfig(raw: Record<string, unknown> | null | undefined): VerificationConfig {
  const r = raw ?? {};
  return {
    recheckDays: Math.round(num(r.recheck_days, 180, 7, 730)),
    checksPerRun: Math.round(num(r.checks_per_run, 500, 10, 5_000)),
    budgetMs: Math.round(num(r.budget_ms, 120_000, 10_000, 240_000)),
    dailyPaidLimit: Math.round(num(r.daily_paid_limit, 500, 0, 1_000_000)),
    providerOrder: idList(r.provider_order),
    escalationProvider: providerId(r.escalation_provider),
    compareProvider: providerId(r.compare_provider),
    comparePercent: num(r.compare_percent, 0, 0, 100),
    suppressInvalid: bool(r.suppress_invalid, true),
  };
}

/** The per-provider daily limit a provider module may set in its own settings. */
export function providerDailyLimit(raw: Record<string, unknown> | null | undefined): number | null {
  const v = (raw ?? {}).daily_limit;
  if (v === undefined || v === null || v === '') return null;
  return Math.round(num(v, 0, 0, 1_000_000));
}
