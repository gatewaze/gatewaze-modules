/**
 * Placement-report parsing for the GlockApps Spamtest v2 test shape.
 *
 * Free of I/O and of any client library so the normalisation rules can be
 * tested directly.
 *
 * Everything here is written defensively, and that is not decoration: this was
 * built from the OpenAPI definitions rather than an observed response, so the
 * first real payload may differ. Every field is optional, unknown values fall
 * through to null rather than into a bucket they might not belong in, and a
 * payload we cannot read at all comes back empty instead of throwing — this
 * feeds a panel on a page whose primary job is unrelated.
 *
 * Shape (definition `glockapps_apiTestItem`):
 *   stats               whole-test totals: inbox / spam / other / notDelivered
 *   inboxes[]           one row per seed mailbox: address, free-text `iType`
 *                       placement, per-seed spf/dkim/dmarc, receiving ip, delay
 *   authenticationResult sender-level auth: DMARC record + verdict, SPF, rDNS,
 *                       HELO, return-path, MTA-STS, BIMI, sender score
 *   spamAssassin / microsoftEOP / googleApps / barracuda / proofPoint
 *                       per-filter verdicts and scores
 *   dnsbl / uribl       blocklist results
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

/** One seed mailbox, flattened for the results table. */
export interface SeedRow {
  email: string;
  provider: string;
  placement: 'inbox' | 'tabs' | 'spam' | 'missing' | null;
  /** Raw GlockApps label, kept so an unrecognised value is still shown. */
  placementLabel: string;
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  ip: string | null;
  /** Seconds to delivery, when reported. */
  deliveredIn: number | null;
  seedName: string | null;
}

/** Sender-level authentication, from `authenticationResult`. */
export interface SenderAuth {
  senderDomain: string | null;
  senderIp: string | null;
  senderScore: number | null;
  rdns: string | null;
  rdnsStatus: string | null;
  helo: string | null;
  returnPath: string | null;
  spfAuth: string | null;
  dkimAuth: string | null;
  dmarcAuth: string | null;
  dmarcRecord: string | null;
  bimi: string | null;
  isp: string | null;
}

/** A spam filter's verdict on the message. */
export interface FilterVerdict {
  name: string;
  /** 'pass' | 'spam' | 'unknown' — normalised across filters that disagree on vocabulary. */
  verdict: 'pass' | 'spam' | 'unknown';
  /** Filter score where one exists (SpamAssassin, Barracuda). */
  score: number | null;
  /** Extra detail worth showing, e.g. EOP's SCL/BCL. */
  detail: string | null;
}

export interface PlacementResult {
  complete: boolean;
  providers: ProviderPlacement[];
  auth: AuthSummary | null;
  seeds: SeedRow[];
  senderAuth: SenderAuth | null;
  filters: FilterVerdict[];
  blocklists: string[];
  raw: unknown;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

function str(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return s.length > 0 ? s : null;
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * `iType` is an untyped string in the spec, so match on substrings rather than
 * an assumed enum — an unrecognised value must not silently land in a bucket it
 * does not belong to.
 */
export function classifyPlacement(iType: unknown): SeedRow['placement'] {
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
  let idx = labels.length - 2;
  if (labels.length >= 3 && labels[labels.length - 2].length <= 3 && labels[labels.length - 1].length <= 3) {
    idx = labels.length - 3;
  }
  return labels[Math.max(idx, 0)] || 'other';
}

function emptyRow(provider: string): ProviderPlacement {
  return { provider, inbox: 0, tabs: 0, spam: 0, missing: 0 };
}

/**
 * Filters disagree on how they say "this is spam": GoogleApps has a boolean
 * `spam`, ProofPoint the same, EOP reports SCL/BCL numbers, SpamAssassin and
 * Barracuda report scores. Normalise to one vocabulary and keep the raw detail.
 */
function readFilters(payload: any): FilterVerdict[] {
  const out: FilterVerdict[] = [];

  const push = (name: string, node: any, verdict: FilterVerdict['verdict'], score: number | null, detail: string | null) => {
    if (!node || node.active === false) return;
    out.push({ name, verdict, score, detail });
  };

  const sa = payload?.spamAssassin;
  if (sa) {
    const score = num(sa.score);
    // SpamAssassin's conventional threshold is 5.0.
    push('SpamAssassin', sa, score === null ? 'unknown' : score >= 5 ? 'spam' : 'pass', score, null);
  }

  const bar = payload?.barracuda;
  if (bar) {
    const score = num(bar.score);
    push('Barracuda', bar, str(bar.reason) ? 'spam' : score === null ? 'unknown' : 'pass', score, str(bar.reason));
  }

  const eop = payload?.microsoftEOP;
  if (eop) {
    const scl = num(eop.scl);
    // Microsoft treats SCL >= 5 as spam; -1 means allow-listed.
    const verdict = scl === null ? 'unknown' : scl >= 5 ? 'spam' : 'pass';
    const bits = [scl !== null ? `SCL ${scl}` : null, num(eop.bcl) !== null ? `BCL ${eop.bcl}` : null, str(eop.cat) ? `cat ${eop.cat}` : null]
      .filter(Boolean)
      .join(' · ');
    push('Microsoft EOP', eop, verdict, scl, bits || null);
  }

  const ga = payload?.googleApps;
  if (ga) {
    push('Google', ga, ga.spam === true ? 'spam' : ga.spam === false ? 'pass' : 'unknown', null, ga.phishy === true ? 'flagged phishy' : null);
  }

  const pp = payload?.proofPoint;
  if (pp) {
    push('ProofPoint', pp, pp.spam === true ? 'spam' : pp.spam === false ? 'pass' : 'unknown', null, null);
  }

  return out;
}

/** DNSBL/URIBL entries that actually list us. Shape is undocumented, so accept
 *  both a list of strings and a list of objects. */
function readBlocklists(payload: any): string[] {
  const out: string[] = [];
  for (const node of [payload?.dnsbl, payload?.uribl]) {
    const results = node?.results;
    if (!Array.isArray(results)) continue;
    for (const r of results) {
      if (typeof r === 'string') {
        out.push(r);
        continue;
      }
      const listed = r?.listed ?? r?.isListed ?? r?.found;
      if (listed === true) out.push(String(r?.name ?? r?.zone ?? r?.list ?? 'unknown'));
    }
  }
  return Array.from(new Set(out));
}

function readSenderAuth(payload: any): SenderAuth | null {
  const a = payload?.authenticationResult;
  if (!a || typeof a !== 'object') return null;
  const dmarcRecord = a.dmarcRecord;
  return {
    senderDomain: str(a.senderDomain),
    senderIp: str(a.senderIp),
    senderScore: num(a.senderScore),
    rdns: str(a.rdns),
    rdnsStatus: str(a.rDNSStatus),
    helo: str(a.helo),
    returnPath: str(a.returnPath),
    spfAuth: str(a.spfAuth),
    dkimAuth: str(a.dkimAuth),
    dmarcAuth: str(a.dmarcAuth),
    // dmarcRecord is an object in the spec; accept a bare string too.
    dmarcRecord: typeof dmarcRecord === 'string' ? str(dmarcRecord) : str(dmarcRecord?.record ?? dmarcRecord?.value),
    bimi: str(a.bimi),
    isp: str(a.isp),
  };
}

export function normalisePlacement(payload: any): PlacementResult {
  const stats = payload?.stats ?? null;
  const rawSeeds: any[] = Array.isArray(payload?.inboxes) ? payload.inboxes : [];

  const byProvider = new Map<string, ProviderPlacement>();
  const auth: AuthSummary = { spf_pass: 0, dkim_pass: 0, dmarc_pass: 0, evaluated: 0 };
  const seeds: SeedRow[] = [];

  for (const seed of rawSeeds) {
    if (seed?.visible === false) continue;
    const provider = providerFromEmail(seed?.email);
    const row = byProvider.get(provider) ?? emptyRow(provider);

    let placement = classifyPlacement(seed?.iType);
    if (!placement && seed?.finished === false) placement = 'missing';
    if (placement) row[placement] += 1;
    byProvider.set(provider, row);

    const spf = str(seed?.spf)?.toLowerCase() ?? null;
    const dkim = str(seed?.dkim)?.toLowerCase() ?? null;
    const dmarc = str(seed?.dmarc)?.toLowerCase() ?? null;
    if (spf || dkim || dmarc) {
      auth.evaluated += 1;
      if (spf === 'pass') auth.spf_pass += 1;
      if (dkim === 'pass') auth.dkim_pass += 1;
      if (dmarc === 'pass') auth.dmarc_pass += 1;
    }

    seeds.push({
      email: String(seed?.email ?? ''),
      provider,
      placement,
      placementLabel: String(seed?.iType ?? '').trim(),
      spf,
      dkim,
      dmarc,
      ip: str(seed?.ip),
      deliveredIn: num(seed?.deliveredIn),
      seedName: str(seed?.seedName),
    });
  }

  const providers = Array.from(byProvider.values()).sort((a, b) => a.provider.localeCompare(b.provider));

  // The overall row comes from `stats` when present — GlockApps' own totals are
  // authoritative over anything summed from seed rows, which can omit seeds
  // still in flight.
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
    seeds,
    senderAuth: readSenderAuth(payload),
    filters: readFilters(payload),
    blocklists: readBlocklists(payload),
    raw: payload,
  };
}
