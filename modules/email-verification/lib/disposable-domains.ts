/**
 * Well-known disposable-address services. Kept short and in the code rather
 * than fetched at run time, so the worker never downloads a list from a
 * third party. A paid provider catches the long tail.
 */
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  '10minutemail.com', '10minutemail.net', '20minutemail.com', 'burnermail.io', 'discard.email',
  'dispostable.com', 'emailondeck.com', 'fakeinbox.com', 'getairmail.com', 'getnada.com',
  'grr.la', 'guerrillamail.biz', 'guerrillamail.com', 'guerrillamail.de', 'guerrillamail.info',
  'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com', 'inboxkitten.com', 'mailcatch.com',
  'maildrop.cc', 'mailinator.com', 'mailinator.net', 'mailinator2.com', 'mailnesia.com',
  'mailpoof.com', 'mintemail.com', 'moakt.com', 'mohmal.com', 'mytemp.email',
  'nada.email', 'sharklasers.com', 'spambox.us', 'spamgourmet.com', 'tempail.com',
  'tempmail.com', 'tempmail.net', 'tempmailo.com', 'temp-mail.io', 'temp-mail.org',
  'tempr.email', 'throwawaymail.com', 'trashmail.com', 'trashmail.de', 'trashmail.net',
  'yopmail.com', 'yopmail.fr', 'yopmail.net',
]);
