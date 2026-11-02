/** Plain-English labels for the admin page. */

export const STATUS_LABEL: Record<string, string> = {
  valid: 'Valid',
  risky: 'Risky',
  invalid: 'Invalid',
};

export const REASON_LABEL: Record<string, string> = {
  syntax: 'Not a valid address',
  domain_typo: 'Misspelt domain, e.g. gmial.com',
  domain_not_found: 'Domain does not exist',
  null_mx: 'Domain accepts no mail',
  no_mx: 'Domain has no mail server',
  disposable: 'Disposable address',
  role: 'Team or no-reply address',
  domain_accepts_mail: 'Domain takes mail (mailbox not checked)',
  mailbox_ok: 'Mailbox exists',
  mailbox_not_found: 'Mailbox does not exist',
  accept_all: 'Domain accepts any address',
  unknown: 'Mail server did not say',
  spam_trap: 'Spam trap',
  hard_bounce: 'Hard bounce from a real send',
};

export function formatCount(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : '0';
}

export function percent(part: number, whole: number): string {
  if (!whole) return '—';
  const p = (part / whole) * 100;
  return `${p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)}%`;
}
