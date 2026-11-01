/**
 * The free checks that need no network: address format, common domain
 * typos, disposable domains and role addresses.
 *
 * DNS is checked separately (lib/mx.ts) because it needs a lookup and is
 * cached per domain.
 */

import type { VerificationReason, VerificationStatus } from './types';
import { DISPOSABLE_DOMAINS } from './disposable-domains';

export interface LocalCheck {
  /** Lower-cased and trimmed. */
  email: string;
  domain: string;
  /** Set when the address fails here and needs no further checks. */
  verdict: { status: VerificationStatus; reason: VerificationReason; suggestion: string | null } | null;
  /** A role address (info@, sales@) is still checked, then marked risky. */
  role: boolean;
}

// Letters, digits and the RFC 5322 "atext" specials, in dot-separated runs.
// Quoted local parts are legal but no real prospect list uses them.
const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
// Dot-separated labels of letters, digits and inner dashes, ending in a
// top-level domain of letters (or an xn-- IDN label).
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** A misspelling of a big mailbox provider's domain, to the domain meant. */
const DOMAIN_TYPOS: Record<string, string> = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gamil.com': 'gmail.com',
  'gnail.com': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com',
  'gmail.cm': 'gmail.com', 'gmail.om': 'gmail.com', 'gmali.com': 'gmail.com', 'gmsil.com': 'gmail.com',
  'googlemail.co': 'googlemail.com',
  'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotmai.com': 'hotmail.com',
  'hotmail.co': 'hotmail.com', 'hotmail.con': 'hotmail.com', 'hotmil.com': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outllok.com': 'outlook.com', 'outlook.co': 'outlook.com', 'outlook.con': 'outlook.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'yhoo.com': 'yahoo.com',
  'iclod.com': 'icloud.com', 'icloud.co': 'icloud.com', 'icloud.con': 'icloud.com', 'icoud.com': 'icloud.com',
};

/** Local parts that reach a team or a machine rather than a person. */
const ROLE_LOCAL_PARTS = new Set([
  'abuse', 'accounts', 'admin', 'administrator', 'billing', 'careers', 'contact', 'enquiries', 'events',
  'feedback', 'hello', 'help', 'hr', 'info', 'inquiries', 'jobs', 'legal', 'mail', 'marketing', 'media',
  'news', 'newsletter', 'office', 'partners', 'postmaster', 'press', 'privacy', 'recruitment', 'sales',
  'security', 'service', 'support', 'team', 'webmaster',
]);

/** Addresses that are never read. Mailing them only adds bounces and complaints. */
const NO_REPLY_RE = /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon)(?:[+.-].*)?$/;

/** The domain, or one of its parent domains, is a known disposable-address service. */
export function isDisposableDomain(domain: string): boolean {
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (DISPOSABLE_DOMAINS.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

export function checkLocally(raw: string): LocalCheck {
  const email = String(raw ?? '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  const local = at > 0 ? email.slice(0, at) : '';
  const domain = at > 0 ? email.slice(at + 1) : '';
  const fail = (status: VerificationStatus, reason: VerificationReason, suggestion: string | null = null): LocalCheck =>
    ({ email, domain, verdict: { status, reason, suggestion }, role: false });

  if (
    email.length > 254 || local.length === 0 || local.length > 64 || domain.length === 0 || domain.length > 253 ||
    email.indexOf('@') !== at || !LOCAL_RE.test(local) || !DOMAIN_RE.test(domain)
  ) {
    return fail('invalid', 'syntax');
  }

  const meant = DOMAIN_TYPOS[domain];
  if (meant) return fail('invalid', 'domain_typo', `${local}@${meant}`);

  if (isDisposableDomain(domain)) return fail('invalid', 'disposable');

  if (NO_REPLY_RE.test(local)) return { email, domain, verdict: { status: 'invalid', reason: 'role', suggestion: null }, role: true };

  const base = local.split('+')[0];
  return { email, domain, verdict: null, role: ROLE_LOCAL_PARTS.has(base) };
}
