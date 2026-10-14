/**
 * Which company runs a recipient's inbox, from the domain's MX records.
 *
 * A company domain whose MX points at Google is Google Workspace and gets
 * Gmail's filtering, so the address alone is not enough. Security gateways
 * (Proofpoint, Mimecast and so on) hide the inbox behind them, so they count
 * as 'other'.
 */

export type Provider = 'google' | 'microsoft' | 'yahoo' | 'apple' | 'other' | 'unknown';

export interface MxRecord {
  exchange: string;
  priority: number;
}

const RULES: Array<[RegExp, Provider]> = [
  [/(^|\.)(google\.com|googlemail\.com)$/, 'google'],
  [/(^|\.)(outlook\.com|protection\.outlook\.com|hotmail\.com)$/, 'microsoft'],
  [/(^|\.)(yahoodns\.net|yahoo\.com)$/, 'yahoo'],
  [/(^|\.)(icloud\.com|me\.com)$/, 'apple'],
];

/** Provider for one MX host name. */
export function providerForMxHost(host: string): Provider {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h) return 'unknown';
  for (const [re, provider] of RULES) if (re.test(h)) return provider;
  return 'other';
}

/**
 * Provider for a domain from its MX records: the lowest-priority (preferred)
 * host decides. No records means mail is not accepted there, so 'unknown'.
 */
export function providerForMx(records: ReadonlyArray<MxRecord>): { provider: Provider; mxHost: string | null } {
  const usable = records.filter((r) => r && typeof r.exchange === 'string' && r.exchange.trim() !== '');
  if (usable.length === 0) return { provider: 'unknown', mxHost: null };
  const best = [...usable].sort((a, b) => a.priority - b.priority)[0];
  const mxHost = best.exchange.trim().toLowerCase().replace(/\.$/, '');
  return { provider: providerForMxHost(mxHost), mxHost };
}

/** A recipient domain worth looking up: letters, digits, dots and dashes, with a dot. */
export function isLookupableDomain(domain: string): boolean {
  return domain.length <= 253 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain);
}
