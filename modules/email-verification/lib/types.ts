/**
 * Shared types for email verification and the provider modules that plug
 * into it.
 *
 * A provider module (id `email-verification-<name>`) exports a
 * `VerificationProvider` as the default export of its `provider.ts`. The core
 * module runs its own free checks first and only asks a provider about
 * addresses that pass them.
 */

/** valid: send. risky: may bounce (catch-all, unknown, role). invalid: will bounce or must not be mailed. */
export type VerificationStatus = 'valid' | 'risky' | 'invalid';

/**
 * How far a check went.
 *   domain:   the free checks only (format, domain, MX). The mailbox itself was not checked.
 *   mailbox:  a provider asked the receiving server about this exact address.
 *   delivery: we sent mail to it and it hard-bounced.
 */
export type VerificationLevel = 'domain' | 'mailbox' | 'delivery';

export type VerificationReason =
  // Free checks
  | 'syntax'
  | 'domain_typo'
  | 'domain_not_found'
  | 'null_mx'
  | 'no_mx'
  | 'disposable'
  | 'role'
  | 'domain_accepts_mail'
  // Provider checks
  | 'mailbox_ok'
  | 'mailbox_not_found'
  | 'accept_all'
  | 'unknown'
  | 'spam_trap'
  // Delivery
  | 'hard_bounce';

/** Who runs the inbox, from the domain's MX records. */
export type MailboxProvider = 'google' | 'microsoft' | 'yahoo' | 'apple' | 'other' | 'unknown';

export interface ProviderResult {
  status: VerificationStatus;
  reason: VerificationReason;
  /** A corrected address the provider suggests, e.g. for a typo. */
  suggestion?: string | null;
  /** The provider's own response, kept for the audit trail. Never include the API key. */
  raw?: unknown;
}

export type ProviderErrorKind =
  /** The key is wrong or revoked. Stop using this provider for the run. */
  | 'auth'
  /** The account is out of credits. Stop using this provider for the run. */
  | 'credits'
  /** Too many calls at once or per day. Stop for this run and try again next run. */
  | 'rate_limit'
  /** A timeout or 5xx. Try the next provider for this address. */
  | 'temporary'
  /** The response could not be understood. Try the next provider for this address. */
  | 'bad_response';

export class ProviderError extends Error {
  constructor(public readonly kind: ProviderErrorKind, message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ProviderContext {
  /** The provider module's own `installed_modules.config`. Secrets may be sealed. */
  config: Record<string, unknown>;
  /** Opens a sealed secret from `config`. Returns null when it is missing or cannot be opened. */
  unsealSecret: (value: unknown) => string | null;
  fetch: typeof fetch;
  /** Aborts when the call has taken too long. */
  signal: AbortSignal;
}

export interface VerificationProvider {
  /** Display name for the admin page, e.g. 'Debounce'. */
  label: string;
  /** Most calls the service accepts at once. */
  concurrency: number;
  /** True when the provider has what it needs, e.g. an API key. Checked once per run. */
  isConfigured(ctx: Omit<ProviderContext, 'signal' | 'fetch'>): boolean;
  /** Check one address. Throw a ProviderError when no answer was obtained. */
  verify(email: string, ctx: ProviderContext): Promise<ProviderResult>;
}

/** The outcome stored for one address. */
export interface VerificationOutcome {
  email: string;
  status: VerificationStatus;
  reason: VerificationReason;
  level: VerificationLevel;
  /** 'builtin' or the provider module id that decided it. */
  decidedBy: string;
  mailboxProvider: MailboxProvider;
  suggestion: string | null;
}
