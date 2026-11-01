/**
 * Domain checks from DNS: does the domain exist, does it accept mail, and
 * who runs its inbox.
 *
 * The provider rules match the email-reputation module's, so a Google
 * Workspace company domain counts as Google in both.
 */

import type { MailboxProvider } from './types';

export interface MxRecord {
  exchange: string;
  priority: number;
}

export interface Resolver {
  resolveMx(domain: string): Promise<MxRecord[]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

export type DomainOutcome =
  /** MX records point at a mail server. */
  | 'accepts_mail'
  /** No MX, but the domain has an address record, so mail may still be delivered to it (RFC 5321 5.1). */
  | 'address_only'
  /** The domain exists but has no MX and no address record. */
  | 'no_mail_host'
  /** The domain publishes a null MX (RFC 7505): it accepts no mail. */
  | 'null_mx'
  /** The domain does not exist. */
  | 'not_found'
  /** DNS did not answer. Try again later, and do not record a verdict. */
  | 'temporary';

export interface DomainResult {
  domain: string;
  outcome: DomainOutcome;
  mailboxProvider: MailboxProvider;
  mxHost: string | null;
  error: string | null;
}

const RULES: Array<[RegExp, MailboxProvider]> = [
  [/(^|\.)(google\.com|googlemail\.com)$/, 'google'],
  [/(^|\.)(outlook\.com|protection\.outlook\.com|hotmail\.com)$/, 'microsoft'],
  [/(^|\.)(yahoodns\.net|yahoo\.com)$/, 'yahoo'],
  [/(^|\.)(icloud\.com|me\.com)$/, 'apple'],
];

export function providerForMxHost(host: string): MailboxProvider {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h) return 'unknown';
  for (const [re, provider] of RULES) if (re.test(h)) return provider;
  return 'other';
}

const NOT_FOUND = new Set(['ENOTFOUND']);
const NO_RECORDS = new Set(['ENODATA']);

function errCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === 'string') return code;
  return String((e as Error)?.message ?? 'lookup failed').slice(0, 80);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function hasAddressRecord(domain: string, resolver: Resolver, timeoutMs: number): Promise<boolean | 'temporary'> {
  let temporary = false;
  for (const lookup of [resolver.resolve4.bind(resolver), resolver.resolve6.bind(resolver)]) {
    try {
      const addrs = await withTimeout(lookup(domain), timeoutMs);
      if (addrs.length > 0) return true;
    } catch (e) {
      const code = errCode(e);
      if (!NOT_FOUND.has(code) && !NO_RECORDS.has(code)) temporary = true;
    }
  }
  return temporary ? 'temporary' : false;
}

export async function lookupDomain(domain: string, resolver: Resolver, timeoutMs = 3_000): Promise<DomainResult> {
  const base = { domain, mailboxProvider: 'unknown' as MailboxProvider, mxHost: null, error: null };
  let records: MxRecord[];
  try {
    records = await withTimeout(resolver.resolveMx(domain), timeoutMs);
  } catch (e) {
    const code = errCode(e);
    if (NOT_FOUND.has(code)) return { ...base, outcome: 'not_found', error: code };
    if (!NO_RECORDS.has(code)) return { ...base, outcome: 'temporary', error: code };
    records = [];
  }

  const usable = records.filter((r) => r && typeof r.exchange === 'string');
  // A null MX is a single record whose exchange is "." (Node reports it as "").
  if (usable.length === 1 && usable[0].exchange.replace(/\.$/, '').trim() === '') {
    return { ...base, outcome: 'null_mx' };
  }
  const hosts = usable.filter((r) => r.exchange.replace(/\.$/, '').trim() !== '');
  if (hosts.length > 0) {
    const best = [...hosts].sort((a, b) => a.priority - b.priority)[0];
    const mxHost = best.exchange.trim().toLowerCase().replace(/\.$/, '');
    return { ...base, outcome: 'accepts_mail', mailboxProvider: providerForMxHost(mxHost), mxHost };
  }

  const address = await hasAddressRecord(domain, resolver, timeoutMs);
  if (address === 'temporary') return { ...base, outcome: 'temporary', error: 'address lookup failed' };
  return { ...base, outcome: address ? 'address_only' : 'no_mail_host', mailboxProvider: address ? 'other' : 'unknown' };
}
