/**
 * Edition cadence (spec-content-discovery-and-research-blocks.md §6): when
 * the next issue of a newsletter goes out, computed in the collection's
 * timezone with Intl (no tz dependency is baked into the worker image).
 *
 *   freq: 'weekly'   byweekday 'MO'..'SU'
 *         'biweekly' byweekday + anchor_date (YYYY-MM-DD of one real issue)
 *         'monthly'  bymonthday 1..31 (clamped to the month's last day)
 *                    or bynthweekday such as '2MO' (second Monday)
 *   hour, minute: local wall-clock send time
 *   create_lead_days: how far ahead the edition is created
 *   research_lead_hours: default research time before the send (default 36)
 *
 * One occurrence per period in v1. Pure.
 */

import { dateAtHour, tzOffsetMinutes } from './research-window.js';

export interface Cadence {
  enabled?: boolean;
  freq: 'weekly' | 'biweekly' | 'monthly';
  byweekday?: 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';
  anchor_date?: string;
  bymonthday?: number;
  bynthweekday?: string;
  hour?: number;
  minute?: number;
  timezone?: string;
  create_lead_days?: number;
  research_lead_hours?: number;
  title_pattern?: string;
}

const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY = 86_400_000;

/** Narrow unknown jsonb to a Cadence, or return the problems. */
export function validateCadence(v: unknown): { cadence: Cadence | null; errors: string[] } {
  const errors: string[] = [];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { cadence: null, errors: ['cadence must be an object'] };
  const c = v as Record<string, unknown>;
  const freq = c.freq;
  if (freq !== 'weekly' && freq !== 'biweekly' && freq !== 'monthly') errors.push('freq must be weekly, biweekly or monthly');
  if ((freq === 'weekly' || freq === 'biweekly') && !WD.includes(String(c.byweekday))) errors.push('byweekday must be one of MO..SU');
  if (freq === 'biweekly' && !/^\d{4}-\d{2}-\d{2}$/.test(String(c.anchor_date ?? ''))) errors.push('biweekly needs anchor_date (YYYY-MM-DD)');
  if (freq === 'monthly') {
    const md = c.bymonthday;
    const nth = c.bynthweekday;
    if (!(Number.isInteger(md) && (md as number) >= 1 && (md as number) <= 31) && !/^[1-4](MO|TU|WE|TH|FR|SA|SU)$/.test(String(nth ?? ''))) errors.push('monthly needs bymonthday 1..31 or bynthweekday like 2MO');
  }
  const hour = c.hour ?? 9;
  const minute = c.minute ?? 0;
  if (!(Number.isInteger(hour) && (hour as number) >= 0 && (hour as number) <= 23)) errors.push('hour must be 0..23');
  if (!(Number.isInteger(minute) && (minute as number) >= 0 && (minute as number) <= 59)) errors.push('minute must be 0..59');
  const tz = String(c.timezone ?? 'UTC');
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { errors.push(`timezone ${tz} is not a valid IANA zone`); }
  const lead = c.create_lead_days ?? 4;
  const rlh = c.research_lead_hours ?? 36;
  if (!(Number.isInteger(lead) && (lead as number) >= 1 && (lead as number) <= 30)) errors.push('create_lead_days must be 1..30');
  if (!(Number.isInteger(rlh) && (rlh as number) >= 1 && (rlh as number) <= 24 * 14)) errors.push('research_lead_hours must be 1..336');
  if (errors.length === 0 && (lead as number) * 24 <= (rlh as number)) errors.push('create_lead_days * 24 must be greater than research_lead_hours, so an edition exists before its research is due');
  if (c.title_pattern !== undefined && (typeof c.title_pattern !== 'string' || c.title_pattern.length > 200)) errors.push('title_pattern must be a string of at most 200 characters');
  return { cadence: errors.length ? null : (c as unknown as Cadence), errors };
}

/** Local calendar date (YYYY-MM-DD) and weekday of an instant in a zone. */
export function localDate(at: Date, tz: string): { ymd: string; weekday: number; day: number; month: number; year: number } {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(at);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  const y = Number(get('year')); const m = Number(get('month')); const d = Number(get('day'));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { ymd: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, weekday, day: d, month: m, year: y };
}

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const weekdayOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** The local send instant for a local calendar date. */
function instantFor(dateYmd: string, c: Cadence): Date {
  const tz = c.timezone ?? 'UTC';
  const base = dateAtHour(dateYmd, c.hour ?? 9, tz);
  return new Date(base.getTime() + (c.minute ?? 0) * 60_000);
}

/** The first occurrence strictly after `after`. */
export function nextOccurrence(c: Cadence, after: Date): Date {
  const tz = c.timezone ?? 'UTC';
  const start = localDate(after, tz);
  let y = start.year, m = start.month, d = start.day;
  // Walk forward day by day (at most ~2 months) until a matching local date whose instant is after `after`.
  for (let i = 0; i < 70; i++) {
    const dateStr = ymd(y, m, d);
    if (matches(c, y, m, d)) {
      const inst = instantFor(dateStr, c);
      if (inst.getTime() > after.getTime()) return inst;
    }
    d += 1;
    if (d > daysInMonth(y, m)) { d = 1; m += 1; if (m > 12) { m = 1; y += 1; } }
  }
  throw new Error('cadence: no occurrence within 70 days');
}

function matches(c: Cadence, y: number, m: number, d: number): boolean {
  const wd = weekdayOf(y, m, d);
  if (c.freq === 'weekly') return WD[wd] === c.byweekday;
  if (c.freq === 'biweekly') {
    if (WD[wd] !== c.byweekday) return false;
    const [ay, am, ad] = String(c.anchor_date).split('-').map(Number);
    const weeks = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ay, am - 1, ad)) / (7 * DAY));
    return Math.abs(weeks) % 2 === 0;
  }
  if (c.bymonthday) {
    const target = Math.min(c.bymonthday, daysInMonth(y, m));
    return d === target;
  }
  if (c.bynthweekday) {
    const n = Number(c.bynthweekday[0]);
    const wdName = c.bynthweekday.slice(1);
    if (WD[wd] !== wdName) return false;
    return Math.ceil(d / 7) === n;
  }
  return false;
}

/** Title for an auto-created edition: `{{send_date}}` or `{{send_date:MMM D}}` tokens only. */
export function editionTitle(pattern: string | undefined, sendAt: Date, tz: string, fallback: string): string {
  const p = (pattern ?? '').trim();
  if (!p) return fallback;
  return p.replace(/\{\{\s*send_date(?::([^}]+))?\s*\}\}/g, (_, fmt?: string) => formatDate(sendAt, tz, (fmt ?? 'MMM D').trim())).slice(0, 500);
}

function formatDate(at: Date, tz: string, fmt: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric' }).formatToParts(at);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  const long = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'long' }).format(at);
  const month2 = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: '2-digit' }).format(at);
  // Longest tokens first so MMM is not eaten by MM.
  return fmt
    .replace(/YYYY/g, get('year'))
    .replace(/MMMM/g, long)
    .replace(/MMM/g, get('month'))
    .replace(/MM/g, month2)
    .replace(/DD/g, get('day').padStart(2, '0'))
    .replace(/\bD\b/g, get('day'));
}

export { tzOffsetMinutes };
