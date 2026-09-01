/**
 * Deterministic identity generation for the synthetic test population.
 *
 * Everything here is a pure function of the sequence number, so re-provisioning
 * produces byte-identical people and a run stays comparable to past runs. That
 * matters more than realism: if names or timezones drifted between provisions,
 * a timezone-distribution change would silently show up as a delivery-pattern
 * change in the next run's chart.
 *
 * Dependency-free on purpose. The obvious alternative (@faker-js/faker) would
 * add a module dependency that has to be baked into the worker image, and this
 * repo has a history of module-dependency resolution breaking startup. A dozen
 * name arrays cost nothing and are deterministic by construction.
 */

/** Default spread, roughly modelling a global audience. Overridable via config. */
export const DEFAULT_TIMEZONE_DISTRIBUTION: Record<string, number> = {
  'America/New_York': 20,
  'America/Los_Angeles': 15,
  'Europe/London': 15,
  'Europe/Berlin': 10,
  'Asia/Kolkata': 10,
  'Asia/Tokyo': 10,
  'Australia/Sydney': 5,
  'America/Sao_Paulo': 5,
  UTC: 10,
};

const FIRST_NAMES = [
  'Ada', 'Blaise', 'Chidi', 'Dara', 'Elif', 'Farid', 'Grace', 'Hana',
  'Ilya', 'Juno', 'Kofi', 'Lena', 'Mateo', 'Nadia', 'Omar', 'Priya',
  'Quinn', 'Rosa', 'Sanjay', 'Tomas', 'Ingrid', 'Viktor', 'Wren', 'Xiulan',
  'Yusuf', 'Zara', 'Anders', 'Beatriz', 'Cyrus', 'Dilara', 'Eero', 'Fumiko',
];

const LAST_NAMES = [
  'Almeida', 'Bakker', 'Chen', 'Duarte', 'Eriksen', 'Fischer', 'Gupta', 'Haddad',
  'Ibrahim', 'Jansen', 'Kowalski', 'Larsen', 'Moreau', 'Nakamura', 'Okafor', 'Petrov',
  'Quintero', 'Rossi', 'Silva', 'Tanaka', 'Ueda', 'Vargas', 'Weber', 'Xu',
  'Yilmaz', 'Zhang', 'Novak', 'Olsen', 'Reyes', 'Sharma', 'Torres', 'Virtanen',
];

/**
 * FNV-1a with a murmur3 fmix32 finalizer. Chosen over `seq % arr.length` so the
 * names in a batch are not a visibly repeating cycle, which reads as obviously
 * fake in a test inbox.
 *
 * The finalizer is not decoration. Callers reduce this modulo a small table
 * length, which keeps only the low bits, and raw FNV-1a's low bits are weak:
 * 'first:N' and 'last:N' collapsed into ~64 distinct pairs across 200 people
 * because the two draws stayed correlated. fmix32 avalanches the whole word
 * before anyone takes a remainder.
 */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Zero-padded so lexicographic order matches numeric order. Shrink-to-count
 *  deletes "highest sequence first" via a plain email sort, which is only
 *  correct while the padding holds. */
export function sequenceToLocalPart(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`send-testing: sequence must be a positive integer, got ${seq}`);
  }
  return `st-${String(seq).padStart(6, '0')}`;
}

export function sequenceToEmail(seq: number, domain: string): string {
  return `${sequenceToLocalPart(seq)}@${domain.toLowerCase()}`;
}

export function parseSequence(email: string): number | null {
  const match = /^st-(\d{6,})@/.exec(email.trim().toLowerCase());
  if (!match) return null;
  const seq = Number.parseInt(match[1], 10);
  return Number.isFinite(seq) ? seq : null;
}

/**
 * Expands a weighted distribution into a lookup band, then picks by hashed
 * sequence. Weights are relative, so callers can express them as percentages or
 * raw counts without normalising first.
 */
export function pickTimezone(
  seq: number,
  distribution: Record<string, number> = DEFAULT_TIMEZONE_DISTRIBUTION,
): string {
  const entries = Object.entries(distribution).filter(([, weight]) => weight > 0);
  if (entries.length === 0) return 'UTC';

  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  // Hash rather than `seq % total` so adjacent sequences do not march through
  // the zones in order, which would make the delivery waves an artefact of
  // ordering rather than of the distribution.
  let point = hash(`tz:${seq}`) % total;
  for (const [zone, weight] of entries) {
    if (point < weight) return zone;
    point -= weight;
  }
  return entries[entries.length - 1][0];
}

export interface TestPersonRow {
  email: string;
  attributes: {
    first_name: string;
    last_name: string;
    timezone: string;
    is_test: true;
    send_testing_sequence: number;
  };
}

export function buildTestPerson(
  seq: number,
  domain: string,
  distribution?: Record<string, number>,
): TestPersonRow {
  const firstName = FIRST_NAMES[hash(`first:${seq}`) % FIRST_NAMES.length];
  const lastName = LAST_NAMES[hash(`last:${seq}`) % LAST_NAMES.length];
  return {
    email: sequenceToEmail(seq, domain),
    attributes: {
      first_name: firstName,
      last_name: lastName,
      timezone: pickTimezone(seq, distribution),
      // The generic marker the People admin filters on, so test rows stay out
      // of everyday views without the core admin knowing this module exists.
      is_test: true,
      send_testing_sequence: seq,
    },
  };
}

export function buildTestPeople(
  startSeq: number,
  endSeq: number,
  domain: string,
  distribution?: Record<string, number>,
): TestPersonRow[] {
  const rows: TestPersonRow[] = [];
  for (let seq = startSeq; seq <= endSeq; seq++) {
    rows.push(buildTestPerson(seq, domain, distribution));
  }
  return rows;
}

/** Addresses whose delivered HTML is kept so an operator can open the message
 *  and click its real unsubscribe link. */
export function isInspectable(seq: number, inspectableCount: number): boolean {
  return seq >= 1 && seq <= inspectableCount;
}
