import { describe, expect, it } from 'vitest';
import { checkLocally, isDisposableDomain } from '../checks';

describe('checkLocally', () => {
  it('passes an ordinary address and lower-cases it', () => {
    const r = checkLocally('  Jane.Doe+news@Example.COM ');
    expect(r.email).toBe('jane.doe+news@example.com');
    expect(r.domain).toBe('example.com');
    expect(r.verdict).toBeNull();
    expect(r.role).toBe(false);
  });

  it.each([
    'plainaddress', '@example.com', 'jane@', 'jane@@example.com', 'jane@example', 'jane@exa_mple.com',
    '.jane@example.com', 'jane.@example.com', 'ja..ne@example.com', 'jane doe@example.com', 'jane@-example.com',
    'jane@example.c', `${'a'.repeat(65)}@example.com`, `jane@${'a'.repeat(250)}.com`,
  ])('rejects %s as syntax', (email) => {
    expect(checkLocally(email).verdict).toEqual({ status: 'invalid', reason: 'syntax', suggestion: null });
  });

  it('rejects an address over 254 characters even when each part is within its own limit', () => {
    const domain = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example.com`;
    expect(checkLocally(`${'x'.repeat(64)}@${domain}`).verdict?.reason).toBe('syntax');
  });

  it('accepts an IDN top-level domain', () => {
    expect(checkLocally('jane@example.xn--p1ai').verdict).toBeNull();
  });

  it('flags a misspelt big-provider domain with the address meant', () => {
    expect(checkLocally('jane@gmial.com').verdict).toEqual({ status: 'invalid', reason: 'domain_typo', suggestion: 'jane@gmail.com' });
  });

  it('flags disposable domains, including their subdomains', () => {
    expect(checkLocally('x@mailinator.com').verdict?.reason).toBe('disposable');
    expect(isDisposableDomain('inbox.mailinator.com')).toBe(true);
    expect(isDisposableDomain('notmailinator.com')).toBe(false);
  });

  it('marks no-reply addresses invalid', () => {
    for (const e of ['noreply@acme.com', 'no-reply@acme.com', 'do-not-reply@acme.com', 'donotreply+x@acme.com']) {
      expect(checkLocally(e).verdict).toEqual({ status: 'invalid', reason: 'role', suggestion: null });
    }
  });

  it('marks team addresses as role without a verdict, so they are still checked', () => {
    const r = checkLocally('info@acme.com');
    expect(r.verdict).toBeNull();
    expect(r.role).toBe(true);
    expect(checkLocally('sales+eu@acme.com').role).toBe(true);
    expect(checkLocally('information@acme.com').role).toBe(false);
  });
});
