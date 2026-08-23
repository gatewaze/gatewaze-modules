import { describe, expect, it } from 'vitest';
import {
  DAILY_CAP,
  SCHEDULED_CAP,
  attributeByEnv,
  clarityConfig,
  clarityDashboardUrl,
  envLabelForHost,
  hostOf,
  parseInsights,
  totalCount,
  totalSessions,
  utcDay,
} from '../clarity.js';

/**
 * Recorded from a real call to
 * GET /export-data/api/v1/project-live-insights?numOfDays=3&dimension1=URL
 * against project y71yyj70j3 on 2026-08-23 (HTTP 200). The `information`
 * arrays came back empty — the project had only just been created — so this
 * fixture pins the ENVELOPE, which is the part the parser has to survive.
 * Nothing in this file makes a network call: the API allows 10 per day.
 */
const REAL_EMPTY = [
  { metricName: 'DeadClickCount', information: [] },
  { metricName: 'ExcessiveScroll', information: [] },
  { metricName: 'RageClickCount', information: [] },
  { metricName: 'QuickbackClick', information: [] },
  { metricName: 'ScriptErrorCount', information: [] },
  { metricName: 'ErrorClickCount', information: [] },
  { metricName: 'ScrollDepth', information: [] },
  { metricName: 'Traffic', information: [] },
  { metricName: 'EngagementTime', information: [] },
];

/**
 * The REAL populated shape, recorded from a second live call on 2026-08-23
 * once sessions had landed. Two things here are not what Microsoft's docs
 * show and both matter:
 *   - the URL dimension column is named `Url`, not `URL`;
 *   - it carries the FULL absolute URL including the hostname, which is what
 *     makes per-environment attribution possible at all (custom tags are not
 *     an export-API dimension);
 *   - a summary row can carry `Url: null`, and the user-count column is
 *     `distinctUserCount` (the docs say `distantUserCount`).
 * Headless-browser visits land in `totalBotSessionCount`, not
 * `totalSessionCount` — Clarity classifies them as bots, correctly.
 */
const REAL_POPULATED = [
  { metricName: 'DeadClickCount', information: [] },
  {
    metricName: 'Traffic',
    information: [
      { totalSessionCount: 0, totalBotSessionCount: 0, distinctUserCount: 1, pagesPerSessionPercentage: 1, Url: null },
      { totalSessionCount: 5, totalBotSessionCount: 2, distinctUserCount: 2, pagesPerSessionPercentage: 1, Url: 'https://lfx.pr-view.com/' },
      { totalSessionCount: 3, totalBotSessionCount: 1, distinctUserCount: 1, pagesPerSessionPercentage: 1, Url: 'https://lfx--newsletter-80.pr-view.com/' },
    ],
  },
];

/** Populated shape, per Microsoft's documented example plus our URL dimension. */
const POPULATED = [
  {
    metricName: 'Traffic',
    information: [
      { totalSessionCount: '12', totalBotSessionCount: '0', distantUserCount: '4', URL: 'https://lfx.pr-view.com/project/overview' },
      { totalSessionCount: '3', totalBotSessionCount: '0', distantUserCount: '2', URL: 'https://lfx--newsletter-80.pr-view.com/' },
    ],
  },
  {
    metricName: 'RageClickCount',
    information: [{ subTotal: '2', URL: 'https://lfx--newsletter-80.pr-view.com/' }],
  },
];

describe('clarityConfig', () => {
  it('is unconfigured without a token, even with a valid project id', () => {
    expect(clarityConfig({ CLARITY_PROJECT_ID: 'y71yyj70j3' }).configured).toBe(false);
  });

  it('is unconfigured with a malformed project id', () => {
    expect(clarityConfig({ CLARITY_PROJECT_ID: '../../etc', CLARITY_DATA_EXPORT_TOKEN: 'x' }).configured).toBe(false);
  });

  it('is configured with both, and does not echo the token in projectId', () => {
    const cfg = clarityConfig({ CLARITY_PROJECT_ID: 'y71yyj70j3', CLARITY_DATA_EXPORT_TOKEN: 'secret' });
    expect(cfg.configured).toBe(true);
    expect(cfg.projectId).toBe('y71yyj70j3');
  });
});

describe('clarityDashboardUrl', () => {
  it('points at the recordings (impressions) list for the project', () => {
    expect(clarityDashboardUrl('y71yyj70j3'))
      .toBe('https://clarity.microsoft.com/projects/view/y71yyj70j3/impressions');
  });
});

describe('parseInsights', () => {
  it('accepts the real empty envelope unchanged', () => {
    expect(parseInsights(REAL_EMPTY)).toEqual(REAL_EMPTY);
  });

  it('rejects a non-array body', () => {
    expect(parseInsights({ error: 'nope' })).toBeNull();
    expect(parseInsights('boom')).toBeNull();
  });

  it('drops entries with an unrecognisable metric name rather than failing', () => {
    const parsed = parseInsights([
      { metricName: '<script>', information: [] },
      { metricName: 'Traffic', information: [] },
    ]);
    expect(parsed?.map((m) => m.metricName)).toEqual(['Traffic']);
  });

  it('caps rows per metric so a hostile response cannot blow up the row', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ n: i }));
    const parsed = parseInsights([{ metricName: 'Traffic', information: many }]);
    expect(parsed?.[0].information.length).toBeLessThanOrEqual(200);
  });
});

describe('totals', () => {
  it('returns null for a metric with no rows, so the UI can say "no data"', () => {
    expect(totalSessions(REAL_EMPTY)).toBeNull();
    expect(totalCount(REAL_EMPTY, 'RageClickCount')).toBeNull();
  });

  it('sums sessions across URL rows', () => {
    expect(totalSessions(POPULATED)).toBe(15);
  });

  it('sums a count metric while ignoring the URL dimension column', () => {
    expect(totalCount(POPULATED, 'RageClickCount')).toBe(2);
  });
});

describe('hostOf', () => {
  it('extracts the host from a full URL', () => {
    expect(hostOf('https://lfx--newsletter-80.pr-view.com/x')).toBe('lfx--newsletter-80.pr-view.com');
  });

  it('returns null for a bare path — the case that makes per-env attribution impossible', () => {
    expect(hostOf('/project/overview')).toBeNull();
  });
});

describe('envLabelForHost', () => {
  it('maps an env hostname to its label', () => {
    expect(envLabelForHost('lfx--newsletter-80.pr-view.com', null)).toBe('lfx--newsletter-80');
  });

  it('resolves the root domain through the current root assignment', () => {
    expect(envLabelForHost('lfx.pr-view.com', 'lfx--nl-80')).toBe('lfx--nl-80');
    expect(envLabelForHost('lfx.pr-view.com', 'primary')).toBe('primary');
  });

  it('ignores hosts that are not ours', () => {
    expect(envLabelForHost('evil.example.com', null)).toBeNull();
    expect(envLabelForHost('lfx-auth.pr-view.com', null)).toBeNull();
  });
});

describe('attributeByEnv against the real recorded response', () => {
  it('groups by env from the `Url` column, resolving the root through the assignment', () => {
    expect(attributeByEnv(REAL_POPULATED, 'lfx--self-serve-1688--newsletter-63')).toEqual({
      'lfx--self-serve-1688--newsletter-63': { Traffic: 5 },
      'lfx--newsletter-80': { Traffic: 3 },
    });
  });

  it('ignores the Url:null summary row rather than counting it as an env', () => {
    const byEnv = attributeByEnv(REAL_POPULATED, null);
    expect(Object.keys(byEnv ?? {})).not.toContain('null');
  });

  it('totals sessions across the real rows, summary row included', () => {
    expect(totalSessions(REAL_POPULATED)).toBe(8);
  });
});

describe('attributeByEnv', () => {
  it('groups sessions per env when the URL dimension carries hostnames', () => {
    const byEnv = attributeByEnv(POPULATED, 'lfx--self-serve-1');
    expect(byEnv).toEqual({
      'lfx--self-serve-1': { Traffic: 12 },
      'lfx--newsletter-80': { Traffic: 3, RageClickCount: 2 },
    });
  });

  it('returns null — not empty, not zeroes — when Clarity gave bare paths', () => {
    const pathsOnly = [{ metricName: 'Traffic', information: [{ totalSessionCount: '9', URL: '/project/overview' }] }];
    expect(attributeByEnv(pathsOnly, null)).toBeNull();
  });
});

describe('budget constants', () => {
  it('leaves manual headroom under Microsoft’s hard daily cap', () => {
    expect(SCHEDULED_CAP).toBeLessThan(DAILY_CAP);
    expect(DAILY_CAP).toBe(10);
  });

  it('keys the budget by UTC day, because that is when Clarity resets', () => {
    expect(utcDay(new Date('2026-08-23T23:59:59Z'))).toBe('2026-08-23');
    expect(utcDay(new Date('2026-08-24T00:00:01Z'))).toBe('2026-08-24');
  });
});
