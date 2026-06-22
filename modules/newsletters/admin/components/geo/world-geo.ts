/**
 * Lightweight, dependency-free world geography for the geo-engagement maps.
 *
 * We deliberately avoid a heavy mapping SDK / external tiles (spec §2, §9): the
 * "map" is a bundled equirectangular SVG with country bubbles positioned at
 * approximate centroids. The accompanying data table (not this file) is the
 * accessible source of truth; the bubble map is the enhancement.
 *
 * Centroids are [longitude, latitude] in degrees, deliberately approximate —
 * they only need to land a bubble in the right part of the world. ISO 3166-1
 * alpha-2 keys (matching SendGrid `ip_geo_country`). Unknown codes simply don't
 * plot a bubble (the table still lists them).
 */

import { WORLD_FEATURES } from './world-atlas.js';

export interface LngLat {
  lng: number;
  lat: number;
}

/** ISO alpha-2 → human display name. */
export const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States', GB: 'United Kingdom', DE: 'Germany', FR: 'France',
  IN: 'India', AU: 'Australia', CA: 'Canada', NL: 'Netherlands', IE: 'Ireland',
  ES: 'Spain', IT: 'Italy', SE: 'Sweden', NO: 'Norway', DK: 'Denmark',
  FI: 'Finland', PL: 'Poland', CH: 'Switzerland', AT: 'Austria', BE: 'Belgium',
  PT: 'Portugal', BR: 'Brazil', MX: 'Mexico', AR: 'Argentina', CL: 'Chile',
  CO: 'Colombia', JP: 'Japan', CN: 'China', KR: 'South Korea', SG: 'Singapore',
  HK: 'Hong Kong', TW: 'Taiwan', ID: 'Indonesia', MY: 'Malaysia', TH: 'Thailand',
  PH: 'Philippines', VN: 'Vietnam', NZ: 'New Zealand', ZA: 'South Africa',
  NG: 'Nigeria', KE: 'Kenya', EG: 'Egypt', MA: 'Morocco', AE: 'UAE',
  SA: 'Saudi Arabia', IL: 'Israel', TR: 'Turkey', RU: 'Russia', UA: 'Ukraine',
  CZ: 'Czechia', RO: 'Romania', GR: 'Greece', HU: 'Hungary', BG: 'Bulgaria',
  PK: 'Pakistan', BD: 'Bangladesh', LK: 'Sri Lanka', NP: 'Nepal', SK: 'Slovakia',
  SI: 'Slovenia', HR: 'Croatia', RS: 'Serbia', LT: 'Lithuania', LV: 'Latvia',
  EE: 'Estonia', IS: 'Iceland', LU: 'Luxembourg', MT: 'Malta', CY: 'Cyprus',
  PE: 'Peru', VE: 'Venezuela', UY: 'Uruguay', EC: 'Ecuador', CR: 'Costa Rica',
  PA: 'Panama', DO: 'Dominican Rep.', GT: 'Guatemala', QA: 'Qatar', KW: 'Kuwait',
  BH: 'Bahrain', OM: 'Oman', JO: 'Jordan', LB: 'Lebanon', GH: 'Ghana',
  TZ: 'Tanzania', UG: 'Uganda', ET: 'Ethiopia', DZ: 'Algeria', TN: 'Tunisia',
  KZ: 'Kazakhstan', AZ: 'Azerbaijan', GE: 'Georgia', AM: 'Armenia', BY: 'Belarus',
  MD: 'Moldova', MM: 'Myanmar', KH: 'Cambodia', LA: 'Laos', MN: 'Mongolia',
};

/** ISO alpha-2 → approximate [lng, lat] centroid. */
export const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  US: [-98, 39], GB: [-1.5, 53], DE: [10, 51], FR: [2.3, 47], IN: [79, 22],
  AU: [134, -25], CA: [-106, 56], NL: [5.3, 52], IE: [-8, 53], ES: [-3.7, 40],
  IT: [12.5, 42], SE: [16, 62], NO: [9, 61], DK: [10, 56], FI: [26, 64],
  PL: [19, 52], CH: [8, 47], AT: [14, 47.5], BE: [4.5, 50.6], PT: [-8, 39.5],
  BR: [-52, -10], MX: [-102, 23], AR: [-64, -34], CL: [-71, -30], CO: [-73, 4],
  JP: [138, 36], CN: [104, 35], KR: [128, 36], SG: [103.8, 1.35], HK: [114.1, 22.3],
  TW: [121, 23.7], ID: [113, -2], MY: [102, 4], TH: [101, 15], PH: [122, 12],
  VN: [106, 16], NZ: [172, -41], ZA: [24, -29], NG: [8, 9.5], KE: [38, 0],
  EG: [30, 27], MA: [-6, 32], AE: [54, 24], SA: [45, 24], IL: [35, 31.5],
  TR: [35, 39], RU: [90, 61], UA: [32, 49], CZ: [15.5, 49.8], RO: [25, 46],
  GR: [22, 39], HU: [19.5, 47], BG: [25, 43], PK: [70, 30], BD: [90, 24],
  LK: [81, 7.8], NP: [84, 28], SK: [19.5, 48.7], SI: [15, 46], HR: [15.5, 45.1],
  RS: [21, 44], LT: [24, 55], LV: [25, 57], EE: [26, 59], IS: [-18, 65],
  LU: [6.1, 49.8], MT: [14.4, 35.9], CY: [33, 35], PE: [-75, -10], VE: [-66, 7],
  UY: [-56, -33], EC: [-78, -1.5], CR: [-84, 10], PA: [-80, 9], DO: [-70.7, 19],
  GT: [-90.5, 15.5], QA: [51.2, 25.3], KW: [47.8, 29.3], BH: [50.6, 26], OM: [56, 21],
  JO: [36, 31], LB: [35.8, 33.9], GH: [-1, 8], TZ: [35, -6], UG: [32, 1],
  ET: [40, 9], DZ: [3, 28], TN: [9, 34], KZ: [68, 48], AZ: [47.5, 40.4],
  GE: [43.5, 42], AM: [45, 40], BY: [28, 53.5], MD: [28.5, 47], MM: [96, 21],
  KH: [105, 12.5], LA: [102, 18], MN: [104, 46],
};

/** Equirectangular projection: degrees → pixel coords within a w×h viewport. */
export function project(lng: number, lat: number, w: number, h: number): { x: number; y: number } {
  return {
    x: ((lng + 180) / 360) * w,
    y: ((90 - lat) / 180) * h,
  };
}

/** Display name for an ISO code; '__other__' → 'Other'; unknown → the code itself. */
export function countryName(code: string | null | undefined): string {
  if (!code) return 'Unknown';
  if (code === '__other__') return 'Other';
  return COUNTRY_NAMES[code] ?? code;
}

/** Centroid for an ISO code, or null if we don't have one (no bubble plotted). */
export function centroid(code: string): LngLat | null {
  const c = COUNTRY_CENTROIDS[code];
  return c ? { lng: c[0], lat: c[1] } : null;
}

// ── choropleth matching ─────────────────────────────────────────────────────
// The RPC's region_code is whatever profile data holds — usually a full English
// country name ("United States"), sometimes a 2-letter ISO code ("AU"), and the
// atlas keys on ISO A3 + an English name that occasionally differs. We resolve a
// region to an atlas A3 code via: normalise → alias table → name index, with a
// 2-letter ISO bridged through COUNTRY_NAMES.

function normName(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const NAME_TO_A3: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const f of WORLD_FEATURES) m.set(normName(f.name), f.a3);
  return m;
})();

/** RPC names whose normalised form differs from the atlas's English name. */
const ALIAS_TO_A3: Map<string, string> = new Map([
  ['united states', 'USA'],
  ['czechia', 'CZE'],
  ['korea republic of', 'KOR'],
  ['russian federation', 'RUS'],
  ['serbia', 'SRB'],
  ['turkiye', 'TUR'],
  ['viet nam', 'VNM'],
]);

/** Resolve a region_code (name or ISO-2) to an atlas A3 code, or null. */
export function resolveA3(regionCode: string | null | undefined): string | null {
  if (!regionCode || regionCode === '__other__') return null;
  let n = normName(regionCode);
  if (regionCode.length === 2) {
    const nm = COUNTRY_NAMES[regionCode.toUpperCase()];
    if (nm) n = normName(nm);
  }
  const direct = ALIAS_TO_A3.get(n) ?? NAME_TO_A3.get(n);
  if (direct) return direct;
  // ISO 3166 long forms ("Bolivia, Plurinational State of") → try the head.
  if (regionCode.includes(',')) {
    const head = normName(regionCode.split(',')[0]);
    return ALIAS_TO_A3.get(head) ?? NAME_TO_A3.get(head) ?? null;
  }
  return null;
}

/** Build an SVG path `d` for a feature's rings under the equirectangular projection. */
export function featurePath(rings: number[][], w: number, h: number): string {
  let d = '';
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const x = ((ring[i] + 180) / 360) * w;
      const y = ((90 - ring[i + 1]) / 180) * h;
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    }
    d += 'Z ';
  }
  return d;
}
