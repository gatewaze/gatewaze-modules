import { describe, expect, it } from 'vitest';
import { lookupDomain, providerForMxHost, type MxRecord, type Resolver } from '../mx';

const err = (code: string) => Object.assign(new Error(code), { code });

function resolver(opts: { mx?: MxRecord[] | Error; a?: string[] | Error; aaaa?: string[] | Error }): Resolver {
  const answer = <T>(v: T | Error | undefined, fallback: T): Promise<T> =>
    v instanceof Error ? Promise.reject(v) : Promise.resolve(v ?? fallback);
  return {
    resolveMx: () => answer(opts.mx, []),
    resolve4: () => answer(opts.a, []),
    resolve6: () => answer(opts.aaaa, []),
  };
}

describe('providerForMxHost', () => {
  it('maps the big providers and treats the rest as other', () => {
    expect(providerForMxHost('ASPMX.L.GOOGLE.COM.')).toBe('google');
    expect(providerForMxHost('acme-com.mail.protection.outlook.com')).toBe('microsoft');
    expect(providerForMxHost('mta5.am0.yahoodns.net')).toBe('yahoo');
    expect(providerForMxHost('mx01.mail.icloud.com')).toBe('apple');
    expect(providerForMxHost('mx1.acme.pphosted.com')).toBe('other');
    expect(providerForMxHost('')).toBe('unknown');
  });
});

describe('lookupDomain', () => {
  it('uses the preferred MX host', async () => {
    const r = await lookupDomain('acme.com', resolver({ mx: [
      { exchange: 'alt1.aspmx.l.google.com', priority: 5 },
      { exchange: 'aspmx.l.google.com', priority: 1 },
    ] }));
    expect(r).toMatchObject({ outcome: 'accepts_mail', mailboxProvider: 'google', mxHost: 'aspmx.l.google.com' });
  });

  it('reads a null MX as accepting no mail', async () => {
    const r = await lookupDomain('nomail.example', resolver({ mx: [{ exchange: '', priority: 0 }] }));
    expect(r.outcome).toBe('null_mx');
  });

  it('reads NXDOMAIN as not found', async () => {
    expect((await lookupDomain('nope.example', resolver({ mx: err('ENOTFOUND') }))).outcome).toBe('not_found');
  });

  it('falls back to address records when there is no MX', async () => {
    expect((await lookupDomain('a.example', resolver({ mx: err('ENODATA'), a: ['192.0.2.1'] }))).outcome).toBe('address_only');
    expect((await lookupDomain('b.example', resolver({ mx: err('ENODATA'), a: err('ENODATA'), aaaa: err('ENODATA') }))).outcome).toBe('no_mail_host');
  });

  it('reports DNS failures as temporary rather than as a verdict', async () => {
    expect((await lookupDomain('c.example', resolver({ mx: err('ESERVFAIL') }))).outcome).toBe('temporary');
    expect((await lookupDomain('d.example', resolver({ mx: err('ENODATA'), a: err('ETIMEOUT') }))).outcome).toBe('temporary');
  });

  it('times out a lookup that never answers', async () => {
    const hang: Resolver = { resolveMx: () => new Promise(() => {}), resolve4: async () => [], resolve6: async () => [] };
    expect((await lookupDomain('slow.example', hang, 20)).outcome).toBe('temporary');
  });
});
