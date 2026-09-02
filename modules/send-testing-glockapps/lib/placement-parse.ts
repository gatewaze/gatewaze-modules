/**
 * Placement-report parsing for the GlockApps Spamtest v2 test shape.
 *
 * Free of I/O and of any client library so the normalisation rules can be
 * tested directly. A payload we cannot recognise comes back empty rather than
 * throwing, because this feeds a panel on a page whose primary job is unrelated.
 *
 * The real shape (definition `glockapps_apiTestItem`) carries:
 *   stats   — authoritative whole-test totals: inbox / spam / other /
 *             notDelivered. `other` is the tabbed placements (Promotions and
 *             friends); `notDelivered` is never-arrived.
 *   inboxes — one row per seed mailbox, with the seed address, a free-text
 *             `iType` placement, and per-seed spf/dkim/dmarc verdicts.
 *
 * Per-provider grouping is derived from the seed address domain rather than
 * `providerGroupId`, which would need a second call to /providers and an id
 * mapping. The domain is already in the payload and is what a reader
 * recognises ("gmail", "outlook") anyway.
 */

export interface ProviderPlacement {
  provider: string;
  inbox: number;
  tabs: number;
  spam: number;
  missing: number;
}

export interface AuthSummary {
  spf_pass: number;
  dkim_pass: number;
  dmarc_pass: number;
  evaluated: number;
}

export interface PlacementResult {
  complete: boolean;
  providers: ProviderPlacement[];
  /** Per-seed authentication verdicts, when the test carries them. */
  auth: AuthSummary | null;
  raw: unknown;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/**
 * `iType` is an untyped string in the spec, so match on substrings rather than
 * an assumed enum — an unrecognised value must not silently land in a bucket it
 * does not belong to.
 */
export function classifyPlacement(iType: unknown): keyof Omit<ProviderPlacement, 'provider'> | null {
  const t = String(iType ?? '').toLowerCase();
  if (!t) return null;
  if (t.includes('spam') || t.includes('junk')) return 'spam';
  if (t.includes('promo') || t.includes('tab') || t.includes('other') || t.includes('categor')) return 'tabs';
  if (t.includes('inbox') || t.includes('primary')) return 'inbox';
  if (t.includes('missing') || t.includes('notdeliver') || t.includes('not_deliver')) return 'missing';
  return null;
}

/** Provider label from a seed address: gmail.com -> gmail, mail.yahoo.co.uk -> yahoo. */
export function providerFromEmail(email: unknown): string {
  const at = String(email ?? '').lastIndexOf('@');
  if (at < 0) return 'other';
  const domain = String(email).slice(at + 1).toLowerCase().trim();
  if (!domain) return 'other';
  const labels = domain.split('.').filter(Boolean);
  if (labels.length === 0) return 'other';
  // Drop the public suffix, and a second label for co.uk-style suffixes.
  let idx = labels.length - 2;
  if (labels.length >= 3 && labels[labels.length - 2].length <= 3 && labels[labels.length - 1].length <= 3) {
    idx = labels.length - 3;
  }
  return labels[Math.max(idx, 0)] || 'other';
}

function emptyRow(provider: string): ProviderPlacement {
  return { provider, inbox: 0, tabs: 0, spam: 0, missing: 0 };
}

export function normalisePlacement(payload: any): PlacementResult {
  const stats = payload?.stats ?? null;
  const seeds: any[] = Array.isArray(payload?.inboxes) ? payload.inboxes : [];

  const byProvider = new Map<string, ProviderPlacement>();
  const auth: AuthSummary = { spf_pass: 0, dkim_pass: 0, dmarc_pass: 0, evaluated: 0 };

  for (const seed of seeds) {
    if (seed?.visible === false) continue;
    const provider = providerFromEmail(seed?.email);
    const row = byProvider.get(provider) ?? emptyRow(provider);

    const bucket = classifyPlacement(seed?.iType);
    if (bucket) row[bucket] += 1;
    else if (seed?.finished === false) row.missing += 1;

    byProvider.set(provider, row);

    // Per-seed authentication verdicts. This is the one place the module can
    // report SPF/DKIM/DMARC — Inbound Parse does not add an
    // Authentication-Results header to the synthetic arrivals.
    const spf = String(seed?.spf ?? '').toLowerCase();
    const dkim = String(seed?.dkim ?? '').toLowerCase();
    const dmarc = String(seed?.dmarc ?? '').toLowerCase();
    if (spf || dkim || dmarc) {
      auth.evaluated += 1;
      if (spf === 'pass') auth.spf_pass += 1;
      if (dkim === 'pass') auth.dkim_pass += 1;
      if (dmarc === 'pass') auth.dmarc_pass += 1;
    }
  }

  const providers = Array.from(byProvider.values()).sort((a, b) => a.provider.localeCompare(b.provider));

  // The overall row comes from `stats` when present — those are GlockApps'
  // own totals and are authoritative over anything summed from seed rows,
  // which can omit seeds still in flight.
  if (stats) {
    providers.unshift({
      provider: 'overall',
      inbox: toCount(stats.inbox),
      tabs: toCount(stats.other),
      spam: toCount(stats.spam),
      missing: toCount(stats.notDelivered),
    });
  } else if (providers.length > 0) {
    providers.unshift(
      providers.reduce(
        (acc, row) => ({
          provider: 'overall',
          inbox: acc.inbox + row.inbox,
          tabs: acc.tabs + row.tabs,
          spam: acc.spam + row.spam,
          missing: acc.missing + row.missing,
        }),
        emptyRow('overall'),
      ),
    );
  }

  return {
    complete: payload?.finished === true,
    providers,
    auth: auth.evaluated > 0 ? auth : null,
    raw: payload,
  };
}
