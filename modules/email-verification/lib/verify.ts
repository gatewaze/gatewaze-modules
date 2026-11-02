/**
 * Decide one address: the free checks first, then the paid providers that are
 * enabled, in order, while the daily limits allow.
 *
 *   1. Format, typo, disposable and no-reply checks. A failure here is final.
 *   2. The domain's DNS (cached per domain by the caller). A missing domain or
 *      a domain that takes no mail is final. A DNS timeout means try later.
 *   3. The first provider that answers decides. A provider that rejects the
 *      key, is out of credits or is rate-limited is skipped for the rest of
 *      the run, and the next one is tried.
 *   4. A catch-all or unknown answer goes to the escalation provider, when one
 *      is set, and its definite answer replaces it.
 *   5. A sample also goes to the compare provider. Its answer is recorded and
 *      never changes the result.
 *
 * With no provider usable the free checks decide, at the 'domain' level.
 */

import { checkLocally } from './checks';
import type { DomainResult } from './mx';
import {
  ProviderError,
  type ProviderErrorKind,
  type ProviderResult,
  type VerificationOutcome,
  type VerificationProvider,
} from './types';

export interface ProviderSlot {
  id: string;
  provider: VerificationProvider;
  config: Record<string, unknown>;
}

export interface ProviderCall {
  provider: string;
  purpose: 'primary' | 'escalation' | 'compare';
  result: ProviderResult | null;
  errorKind: ProviderErrorKind | null;
  error: string | null;
}

export interface VerifyDeps {
  /** Cached DNS lookup for a domain. */
  domain(domain: string): Promise<DomainResult>;
  /** Providers in the order to try them, with escalation and compare excluded unless also listed. */
  primary: ProviderSlot[];
  escalation: ProviderSlot | null;
  compare: ProviderSlot | null;
  /** True when this address falls in the compare sample. */
  inCompareSample(email: string): boolean;
  /** Reserve one paid check for the provider. False when a daily limit is used up. */
  take(providerId: string): boolean;
  /** Give back a reserved check that produced no answer. */
  giveBack(providerId: string): void;
  /** Providers that failed with auth, credits or rate_limit this run. Shared across addresses. */
  stopped: Set<string>;
  call(slot: ProviderSlot, email: string): Promise<ProviderResult>;
}

export interface VerifyResult {
  /** Null when DNS did not answer: record nothing and try again later. */
  outcome: VerificationOutcome | null;
  calls: ProviderCall[];
  /** True when providers exist but none answered (limits, errors). The result is domain-level for now. */
  paidPending: boolean;
}

const STOP_KINDS: ReadonlySet<ProviderErrorKind> = new Set(['auth', 'credits', 'rate_limit']);
const KINDS: ReadonlySet<string> = new Set(['auth', 'credits', 'rate_limit', 'temporary', 'bad_response']);

/**
 * The error kind a provider reported. Providers in other repositories throw
 * their own error class, so any error with a known `kind` counts.
 */
export function errorKind(e: unknown): ProviderErrorKind {
  if (e instanceof ProviderError) return e.kind;
  const kind = (e as { kind?: unknown })?.kind;
  return typeof kind === 'string' && KINDS.has(kind) ? (kind as ProviderErrorKind) : 'temporary';
}
const ESCALATE_REASONS = new Set(['accept_all', 'unknown']);

async function tryProvider(
  slot: ProviderSlot,
  email: string,
  purpose: ProviderCall['purpose'],
  deps: VerifyDeps,
  calls: ProviderCall[],
): Promise<ProviderResult | null> {
  if (deps.stopped.has(slot.id) || !deps.take(slot.id)) return null;
  try {
    const result = await deps.call(slot, email);
    calls.push({ provider: slot.id, purpose, result, errorKind: null, error: null });
    return result;
  } catch (e) {
    deps.giveBack(slot.id);
    const kind = errorKind(e);
    if (STOP_KINDS.has(kind)) deps.stopped.add(slot.id);
    calls.push({ provider: slot.id, purpose, result: null, errorKind: kind, error: String((e as Error)?.message ?? e).slice(0, 200) });
    return null;
  }
}

export async function verifyAddress(raw: string, deps: VerifyDeps): Promise<VerifyResult> {
  const calls: ProviderCall[] = [];
  const local = checkLocally(raw);
  const email = local.email;
  const builtin = (o: Omit<VerificationOutcome, 'email' | 'level' | 'decidedBy'>): VerificationOutcome =>
    ({ email, level: 'domain', decidedBy: 'builtin', ...o });

  if (local.verdict) {
    return {
      outcome: builtin({ ...local.verdict, mailboxProvider: 'unknown' }),
      calls,
      paidPending: false,
    };
  }

  const dom = await deps.domain(local.domain);
  const mailboxProvider = dom.mailboxProvider;
  switch (dom.outcome) {
    case 'temporary':
      return { outcome: null, calls, paidPending: false };
    case 'not_found':
      return { outcome: builtin({ status: 'invalid', reason: 'domain_not_found', mailboxProvider, suggestion: null }), calls, paidPending: false };
    case 'null_mx':
      return { outcome: builtin({ status: 'invalid', reason: 'null_mx', mailboxProvider, suggestion: null }), calls, paidPending: false };
    case 'no_mail_host':
      return { outcome: builtin({ status: 'invalid', reason: 'no_mx', mailboxProvider, suggestion: null }), calls, paidPending: false };
    default:
      break;
  }

  const fromDns: VerificationOutcome = dom.outcome === 'address_only'
    ? builtin({ status: 'risky', reason: 'no_mx', mailboxProvider, suggestion: null })
    : local.role
      ? builtin({ status: 'risky', reason: 'role', mailboxProvider, suggestion: null })
      : builtin({ status: 'valid', reason: 'domain_accepts_mail', mailboxProvider, suggestion: null });

  if (deps.primary.length === 0) return { outcome: fromDns, calls, paidPending: false };

  let decided: { slot: ProviderSlot; result: ProviderResult } | null = null;
  for (const slot of deps.primary) {
    const result = await tryProvider(slot, email, 'primary', deps, calls);
    if (result) { decided = { slot, result }; break; }
  }
  if (!decided) return { outcome: fromDns, calls, paidPending: true };

  if (
    decided.result.status === 'risky' && ESCALATE_REASONS.has(decided.result.reason) &&
    deps.escalation && deps.escalation.id !== decided.slot.id
  ) {
    const second = await tryProvider(deps.escalation, email, 'escalation', deps, calls);
    if (second && second.status !== 'risky') decided = { slot: deps.escalation, result: second };
  }

  if (deps.compare && deps.inCompareSample(email) && !calls.some((c) => c.provider === deps.compare!.id && c.result)) {
    await tryProvider(deps.compare, email, 'compare', deps, calls);
  }

  const r = decided.result;
  // A role address the provider calls deliverable is still a team inbox.
  const roleRisky = local.role && r.status === 'valid';
  return {
    outcome: {
      email,
      status: roleRisky ? 'risky' : r.status,
      reason: roleRisky ? 'role' : r.reason,
      level: 'mailbox',
      decidedBy: decided.slot.id,
      mailboxProvider,
      suggestion: r.suggestion ?? null,
    },
    calls,
    paidPending: false,
  };
}

/** A stable 0 to 99 bucket for an address, so the compare sample does not change between runs. */
export function sampleBucket(email: string): number {
  let h = 2166136261;
  for (let i = 0; i < email.length; i++) {
    h ^= email.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100;
}
