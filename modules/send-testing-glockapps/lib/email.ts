/**
 * Linear-time email shape check.
 *
 * Deliberately NOT a regex. The obvious `^[^@\s]+@[^@\s]+\.[^@\s]+$` is
 * ambiguous — `[^@\s]+` and `\.[^@\s]+` can both match a dot, so the engine
 * backtracks and input like `a@` followed by many `!.` repetitions costs
 * quadratic time. That input arrives here from a pasted seed list, so it is
 * attacker-influenceable; CodeQL flags it as js/polynomial-redos.
 *
 * Splitting on '@' and scanning once is linear no matter what the input is.
 */

/** Longest address we will consider. RFC 5321 caps a path at 256 octets. */
const MAX_LENGTH = 254;

export function isPlausibleEmail(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const email = value.trim();
  if (email.length === 0 || email.length > MAX_LENGTH) return false;

  // Exactly one '@', with content on both sides.
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) return false;

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  // No whitespace anywhere; a single indexOf scan per half.
  if (/\s/.test(email)) return false;

  // The domain needs at least one dot, not leading or trailing, and no empty
  // labels ('a..b').
  const dot = domain.indexOf('.');
  if (dot <= 0 || dot === domain.length - 1) return false;
  if (domain.includes('..')) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;

  return local.length > 0;
}

export function normaliseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return isPlausibleEmail(email) ? email : null;
}
