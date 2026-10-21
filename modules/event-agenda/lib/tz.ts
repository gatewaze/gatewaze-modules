/**
 * Local wall-clock times to UTC, for sources that publish a timezone name
 * rather than offsets. Sessionize gives session times as naive local
 * strings ("2026-10-05T10:50:00") and the event's timezone as a Windows
 * name ("Eastern Standard Time"), so the name is mapped to an IANA zone and
 * the offset is read from Intl for that instant, which handles daylight
 * saving without a table of rules.
 */

/** The Windows timezone names conferences actually use, to IANA. */
const WINDOWS_TO_IANA: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Central Standard Time': 'America/Chicago',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'SA Pacific Standard Time': 'America/Bogota',
  'SA Western Standard Time': 'America/La_Paz',
  'SA Eastern Standard Time': 'America/Cayenne',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'UTC': 'Etc/UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'GTB Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Kiev',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Egypt Standard Time': 'Africa/Cairo',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'Morocco Standard Time': 'Africa/Casablanca',
  'Russian Standard Time': 'Europe/Moscow',
  'Arabian Standard Time': 'Asia/Dubai',
  'Arab Standard Time': 'Asia/Riyadh',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Kolkata',
  'Sri Lanka Standard Time': 'Asia/Colombo',
  'Nepal Standard Time': 'Asia/Kathmandu',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Singapore Standard Time': 'Asia/Singapore',
  'China Standard Time': 'Asia/Shanghai',
  'Taipei Standard Time': 'Asia/Taipei',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'W. Australia Standard Time': 'Australia/Perth',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'Tasmania Standard Time': 'Australia/Hobart',
  'New Zealand Standard Time': 'Pacific/Auckland',
};

/** An IANA zone for a Windows name, an IANA name passed through, or null. */
export function toIanaZone(name: string | null | undefined): string | null {
  const s = String(name ?? '').trim();
  if (!s) return null;
  if (WINDOWS_TO_IANA[s]) return WINDOWS_TO_IANA[s];
  if (/^[A-Za-z_]+\/[A-Za-z_+-]+(\/[A-Za-z_+-]+)?$/.test(s) || s === 'UTC') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: s });
      return s;
    } catch {
      return null;
    }
  }
  return null;
}

/** The zone's offset from UTC in minutes at a given instant. */
export function offsetMinutesAt(zone: string, instantMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instantMs) / 60_000);
}

/**
 * "2026-10-05T10:50:00" in `zone` → "2026-10-05T13:50:00Z". With no zone
 * the wall-clock value is returned as if it were UTC, which keeps the
 * programme in order and is marked by the caller.
 */
export function localToUtcIso(local: string, zone: string | null): string | null {
  const m = String(local ?? '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  if (!zone) return new Date(naive).toISOString().replace(/\.\d{3}Z$/, 'Z');
  // Two passes: the offset at the naive instant, then at the corrected one,
  // so a time inside a DST change still lands on the right side of it.
  let instant = naive - offsetMinutesAt(zone, naive) * 60_000;
  instant = naive - offsetMinutesAt(zone, instant) * 60_000;
  return new Date(instant).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
