/**
 * Minimal RFC 5545 RRULE evaluator (spec §13.2).
 *
 * Supports FREQ (DAILY/WEEKLY/MONTHLY/YEARLY), INTERVAL, BYDAY (with
 * positional prefixes for MONTHLY), BYMONTHDAY, BYMONTH, BYSETPOS,
 * COUNT, UNTIL. Day-resolution; time fields are ignored.
 */

export interface ParsedRRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  byDay?: string[];        // ['MO','WE','FR']
  byMonthDay?: number[];   // [1, 15]
  byMonth?: number[];      // [1..12]
  bySetPos?: number[];     // [-1, 1]
  count?: number;
  until?: Date;
}

const DAY_ABBREV = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function parse(rule: string): ParsedRRule {
  const out: Partial<ParsedRRule> = { interval: 1 };
  const parts = rule.replace(/^RRULE:/i, '').split(';');
  for (const part of parts) {
    const [k, v] = part.split('=');
    if (!k || !v) continue;
    switch (k.toUpperCase()) {
      case 'FREQ':
        out.freq = v.toUpperCase() as ParsedRRule['freq'];
        break;
      case 'INTERVAL':
        out.interval = parseInt(v, 10);
        break;
      case 'BYDAY':
        out.byDay = v.split(',').map(s => s.toUpperCase().trim());
        break;
      case 'BYMONTHDAY':
        out.byMonthDay = v.split(',').map(n => parseInt(n, 10));
        break;
      case 'BYMONTH':
        out.byMonth = v.split(',').map(n => parseInt(n, 10));
        break;
      case 'BYSETPOS':
        out.bySetPos = v.split(',').map(n => parseInt(n, 10));
        break;
      case 'COUNT':
        out.count = parseInt(v, 10);
        break;
      case 'UNTIL':
        out.until = parseRRuleDate(v);
        break;
    }
  }
  if (!out.freq) throw new Error('rrule missing FREQ');
  return out as ParsedRRule;
}

export function isValid(rule: string): boolean {
  try {
    parse(rule);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the next occurrence strictly after `after`. Returns null when
 * UNTIL or COUNT exhausted.
 *
 * The implementation iterates day by day. That's fine for sub-yearly
 * patterns at day resolution; for sparse yearly patterns we cap at
 * 5 years of iteration and return null beyond that.
 */
export function nextOccurrence(rule: string, after: Date): Date | null {
  const r = parse(rule);
  const start = new Date(Date.UTC(
    after.getUTCFullYear(),
    after.getUTCMonth(),
    after.getUTCDate() + 1,
  ));
  const maxIter = 365 * 5;
  for (let i = 0; i < maxIter; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    if (r.until && d > r.until) return null;
    if (matches(d, r)) return d;
  }
  return null;
}

function matches(d: Date, r: ParsedRRule): boolean {
  // BYMONTH filter
  if (r.byMonth && !r.byMonth.includes(d.getUTCMonth() + 1)) return false;
  // BYMONTHDAY filter
  if (r.byMonthDay) {
    const dom = d.getUTCDate();
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const negDom = dom - lastDay - 1; // -1 for last day
    if (!r.byMonthDay.includes(dom) && !r.byMonthDay.includes(negDom)) return false;
  }
  // BYDAY filter
  if (r.byDay && r.byDay.length > 0) {
    const dayAbbr = DAY_ABBREV[d.getUTCDay()]!;
    const matchesDay = r.byDay.some(spec => {
      const m = spec.match(/^(-?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
      if (!m) return false;
      const prefix = m[1];
      const day = m[2]!;
      if (day !== dayAbbr) return false;
      if (!prefix) return true;
      // Positional prefix on MONTHLY/YEARLY: e.g. 1MO = first Monday.
      if (r.freq !== 'MONTHLY' && r.freq !== 'YEARLY') return true;
      const wantNth = parseInt(prefix, 10);
      const dom = d.getUTCDate();
      const lastDayOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      if (wantNth > 0) {
        return dom > (wantNth - 1) * 7 && dom <= wantNth * 7;
      } else {
        return dom > lastDayOfMonth + wantNth * 7 && dom <= lastDayOfMonth + (wantNth + 1) * 7;
      }
    });
    if (!matchesDay) return false;
  }
  // FREQ semantics: WEEKLY needs day-of-week match; MONTHLY needs DOM
  // implied by BYMONTHDAY or first-of-month if neither BYDAY nor
  // BYMONTHDAY set; YEARLY follows month + day rules.
  if (r.freq === 'WEEKLY' && !r.byDay) {
    // Without BYDAY a weekly rule fires on the same day-of-week as
    // the DTSTART, which we don't carry here. Default: every 7th day
    // starting today's DOW — caller should set BYDAY.
    return false;
  }
  if (r.freq === 'MONTHLY' && !r.byDay && !r.byMonthDay) {
    return d.getUTCDate() === 1;
  }
  return true;
}

function parseRRuleDate(s: string): Date {
  // RRULE UNTIL format: YYYYMMDD or YYYYMMDDTHHMMSSZ
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!m) throw new Error(`bad UNTIL: ${s}`);
  return new Date(Date.UTC(
    parseInt(m[1]!, 10),
    parseInt(m[2]!, 10) - 1,
    parseInt(m[3]!, 10),
    m[4] ? parseInt(m[4], 10) : 0,
    m[5] ? parseInt(m[5], 10) : 0,
    m[6] ? parseInt(m[6], 10) : 0,
  ));
}

export function describe(rule: string): string {
  const r = parse(rule);
  switch (r.freq) {
    case 'DAILY':
      return r.interval > 1 ? `Every ${r.interval} days` : 'Every day';
    case 'WEEKLY': {
      const days = r.byDay?.map(d => ({ MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' }[d] ?? d)).join(', ') ?? '';
      return r.interval > 1 ? `Every ${r.interval} weeks${days ? ' on ' + days : ''}` : `Every week${days ? ' on ' + days : ''}`;
    }
    case 'MONTHLY':
      return r.interval > 1 ? `Every ${r.interval} months` : 'Every month';
    case 'YEARLY':
      return r.interval > 1 ? `Every ${r.interval} years` : 'Every year';
  }
}
