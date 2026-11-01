/**
 * The paid-check budget for one worker run: a daily limit across all
 * providers, plus any limit a provider module sets for itself.
 */

import { providerDailyLimit, type VerificationConfig } from './config';

export interface Budget {
  /** Reserve one paid check for the provider. False when a limit is used up. */
  take(providerId: string): boolean;
  /** Give back a reserved check that produced no answer. */
  giveBack(providerId: string): void;
  /** Checks left across all providers. */
  left(): number;
}

/**
 * `usage` is today's rows from email_verification_usage. Pass null when they
 * could not be read: the budget is then zero, so a failed read can never
 * make a used-up limit look fresh.
 */
export function makeBudget(
  usage: Array<{ provider: string; checks: number }> | null,
  dailyPaidLimit: number,
  providers: Array<{ id: string; config: Record<string, unknown> }>,
): Budget {
  const usedBy = new Map<string, number>((usage ?? []).map((u) => [u.provider, Number(u.checks) || 0]));
  let total = usage === null ? 0 : Math.max(0, dailyPaidLimit - [...usedBy.values()].reduce((a, b) => a + b, 0));
  const perProvider = new Map<string, number>();
  for (const p of providers) {
    const cap = providerDailyLimit(p.config);
    perProvider.set(p.id, cap === null ? Infinity : Math.max(0, cap - (usedBy.get(p.id) ?? 0)));
  }
  return {
    take(id) {
      const mine = perProvider.get(id) ?? 0;
      if (total <= 0 || mine <= 0) return false;
      total--;
      perProvider.set(id, mine - 1);
      return true;
    },
    giveBack(id) {
      total++;
      perProvider.set(id, (perProvider.get(id) ?? 0) + 1);
    },
    left: () => total,
  };
}

/** Providers in the configured order; with no order set, every enabled provider by id. */
export function orderProviders<T extends { id: string }>(loaded: T[], config: Pick<VerificationConfig, 'providerOrder' | 'escalationProvider' | 'compareProvider'>): {
  primary: T[]; escalation: T | null; compare: T | null;
} {
  const byId = new Map(loaded.map((p) => [p.id, p]));
  const special = new Set([config.escalationProvider, config.compareProvider].filter(Boolean));
  // A provider set only for escalation or compare is not also a first choice,
  // unless the order names it.
  const primary = config.providerOrder.length > 0
    ? config.providerOrder.map((id) => byId.get(id)).filter((p): p is T => !!p)
    : [...loaded].filter((p) => !special.has(p.id)).sort((a, b) => a.id.localeCompare(b.id));
  return {
    primary,
    escalation: config.escalationProvider ? byId.get(config.escalationProvider) ?? null : null,
    compare: config.compareProvider ? byId.get(config.compareProvider) ?? null : null,
  };
}
