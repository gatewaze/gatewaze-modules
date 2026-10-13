/**
 * The Spotify for Creators CSV exports (lib/csv-reports.ts).
 *
 * The fixtures are trimmed from real exports taken from the Agentic
 * Conversations account on 2026-10-12. Every case below exists because
 * getting it wrong produces a confident, plausible, wrong number rather than
 * an error, which is the only failure mode that reaches a public page.
 */

import { describe, it, expect } from 'vitest';
import {
  FIELD_KINDS,
  type MetricField,
  differenceCumulative,
  identifyReport,
  matchEpisodeSlug,
  parseCsvLine,
  parseDay,
  parseSpotifyReport,
  totalFor,
} from '../lib/csv-reports';

const SHOW = 'AgenticConversationsformallymlops.community';

// Daily, show level. Note the UTF-8 BOM before "Date", which the real file has.
const PERFORMANCE = `﻿Date,Plays & downloads,Plays (on Spotify),Downloads (everywhere else),Audience,Audience (on Spotify),Audience (everywhere else)
3/23/2020,0,0,,,,
3/25/2020,3,0,3,3,,3
10/10/2026,314,96,218,180,61,119
10/11/2026,161,54,107,96,33,63
10/12/2026,99,30,69,64,22,42`;

// Cumulative, episode level. Same "Plays & downloads" heading as above.
const PER_EPISODE = `Date,Plays & downloads,Audience
9/26/2025,440,438
9/27/2025,750,734
9/28/2025,894,862
9/29/2025,1037,978
9/30/2025,1410,1268
10/1/2025,1521,1350
10/2/2025,1598,1417
10/3/2025,1654,1466
10/4/2025,1698,1501
10/5/2025,1733,1531
10/6/2025,1780,1570`;

const ENGAGEMENT = `Date,Consumption time (hours),Average consumption time (hours),Comments,Followers
3/27/2020,0.44,0.44,,2
3/28/2020,0.08,0.08,,3
10/10/2026,39.88,0.623125,,8954
10/11/2026,27.14,0.6785,,8957
10/12/2026,6.98,0.30347826086956525,,`;

const SEGMENTS = `Date,Total,Returning,New
5/2/2026,90,76,14
5/3/2026,70,55,15
5/3/2026,70,55,15
5/4/2026,76,58,18`;

const IMPRESSIONS = `Date,Impressions
7/13/2026,2218
7/14/2026,2645
7/15/2026,1904`;

const GENDER = `Gender,Percentage
Male,76.67820069204151
Female,19.792387543252595
Non-binary,0.8996539792387545
Not specified,2.629757785467128`;

const AGE_BY_GENDER = `Age,Total percentage,Male percentage,Female percentage,Non-binary percentage,Not specified percentage
0-17,0.4844290657439446,0.27681660899653976,0.06920415224913494,0,0.13840830449826988
35-44,35.155709342560556,28.304498269896193,6.159169550173011,0.13840830449826988,0.5536332179930795`;

describe('scope', () => {
  it('reads the episode slug out of the filename', () => {
    const r = parseSpotifyReport(`${SHOW}_AreEvalsDead_PerformanceCombined_since-published.csv`, PER_EPISODE);
    expect(r.identity.scope).toBe('episode');
    expect(r.identity.episodeSlug).toBe('AreEvalsDead');
  });

  it('treats a file with no episode segment as show level', () => {
    const r = parseSpotifyReport(`${SHOW}_Performance_all-time.csv`, PERFORMANCE);
    expect(r.identity.scope).toBe('show');
    expect(r.identity.episodeSlug).toBeNull();
  });

  it('CANNOT tell scope from the data, so the two impressions files differ only by name', () => {
    // Byte-identical headers. This is why the filename is required, and why
    // a renamed file loses its scope rather than being guessed at.
    const show = parseSpotifyReport(`${SHOW}_DailyImpressions_7-13-2026--10-10-2026.csv`, IMPRESSIONS);
    const ep = parseSpotifyReport(`${SHOW}_AreEvalsDead_DailyImpressions_7-13-2026--10-10-2026.csv`, IMPRESSIONS);
    expect(show.identity.kind).toBe(ep.identity.kind);
    expect(show.identity.scope).toBe('show');
    expect(ep.identity.scope).toBe('episode');
  });
});

describe('daily versus cumulative', () => {
  it('reads the show performance export as daily', () => {
    const r = parseSpotifyReport(`${SHOW}_Performance_all-time.csv`, PERFORMANCE);
    expect(r.identity.series).toBe('daily');
    expect(totalFor('plays', r.rows).value).toBe(0 + 3 + 314 + 161 + 99);
  });

  it('reads the per-episode export as cumulative and differences it', () => {
    // Summing the raw column gives 14,515 for an episode that had 1,780.
    const r = parseSpotifyReport(`${SHOW}_AreEvalsDead_PerformanceCombined_since-published.csv`, PER_EPISODE);
    expect(r.identity.series).toBe('cumulative');
    expect(totalFor('plays', r.rows).value).toBe(1780);
    expect(totalFor('audience', r.rows).value).toBeNull(); // unique, see below
    // The deltas are the daily figures, so day two is 750-440.
    expect(r.rows[1].plays).toBe(310);
  });

  it('says so rather than deciding when the series is too short to classify', () => {
    const short = 'Date,Impressions\n1/1/2026,1\n1/2/2026,2\n1/3/2026,3';
    const id = identifyReport('Show_DailyImpressions_x.csv', ['Date', 'Impressions'],
      [['1/1/2026', '1'], ['1/2/2026', '2'], ['1/3/2026', '3']]);
    expect(id.problem).toMatch(/cannot be told apart/);
    expect(parseSpotifyReport('Show_DailyImpressions_x.csv', short).identity.problem)
      .toMatch(/cannot be told apart/);
  });

  it('never differences followers, because it is a level even in a rising file', () => {
    const r = parseSpotifyReport(`${SHOW}_Engagement_all-time.csv`, ENGAGEMENT);
    expect(totalFor('followers', r.rows).value).toBe(8957);
  });
});

describe('differenceCumulative', () => {
  it('sums back to the final cumulative value', () => {
    const d = differenceCumulative([440, 750, 894]);
    expect(d).toEqual([440, 310, 144]);
    expect((d as number[]).reduce((a, b) => a + b, 0)).toBe(894);
  });

  it('records nothing rather than a negative when a total drops', () => {
    expect(differenceCumulative([100, 90, 120])).toEqual([100, undefined, 30]);
  });

  it('passes blanks through', () => {
    expect(differenceCumulative([10, undefined, 30])).toEqual([10, undefined, 20]);
  });
});

describe('field kinds stop a level or a unique count being summed', () => {
  it('classifies every field it parses', () => {
    const fields: MetricField[] = ['plays', 'playsSpotify', 'downloadsElsewhere', 'audience',
      'audienceSpotify', 'audienceElsewhere', 'audienceReturning', 'audienceNew',
      'consumptionSeconds', 'comments', 'followers', 'impressions'];
    for (const f of fields) expect(FIELD_KINDS[f], f).toBeDefined();
    // And the map covers nothing it cannot parse.
    expect(Object.keys(FIELD_KINDS).sort()).toEqual([...fields].sort());
  });

  it('sums a flow', () => {
    const r = parseSpotifyReport(`${SHOW}_DailyImpressions_x.csv`, IMPRESSIONS);
    expect(totalFor('impressions', r.rows)).toMatchObject({ value: 2218 + 2645 + 1904, basis: 'sum' });
  });

  it('takes the latest for a level, never the sum', () => {
    const r = parseSpotifyReport(`${SHOW}_Engagement_all-time.csv`, ENGAGEMENT);
    const t = totalFor('followers', r.rows);
    expect(t).toMatchObject({ value: 8957, basis: 'latest' });
    // The naive sum of this fixture's followers column.
    expect(t.value).not.toBe(2 + 3 + 8954 + 8957);
  });

  it('refuses to produce a single figure for a daily unique count', () => {
    // "487,185 listeners" came from summing this field. It is wrong by
    // however many people listened on more than one day.
    const r = parseSpotifyReport(`${SHOW}_Performance_all-time.csv`, PERFORMANCE);
    const t = totalFor('audience', r.rows);
    expect(t.value).toBeNull();
    expect(t.note).toMatch(/cannot be summed/);
    expect(t.note).toMatch(/Peak day was 180/);
  });
});

describe('the awkward real-world details', () => {
  it('strips the BOM the Performance export carries', () => {
    const r = parseSpotifyReport(`${SHOW}_Performance_all-time.csv`, PERFORMANCE);
    expect(r.unknownHeadings).toEqual([]);
    expect(r.rows[0].day).toBe('2020-03-23');
  });

  it('deduplicates a repeated date instead of double counting it', () => {
    // The real Audience Segments export repeats 5/3/2026.
    const r = parseSpotifyReport(`${SHOW}_AudienceSegments_x.csv`, SEGMENTS);
    expect(r.rows).toHaveLength(3);
    expect(totalFor('audienceNew', r.rows).value).toBe(14 + 15 + 18);
  });

  it('keeps an empty cell empty rather than calling it zero', () => {
    // The last Engagement row has no Followers value. Zero followers would
    // read as the audience vanishing overnight.
    const r = parseSpotifyReport(`${SHOW}_Engagement_all-time.csv`, ENGAGEMENT);
    const last = r.rows[r.rows.length - 1];
    expect(last.day).toBe('2026-10-12');
    expect(last.followers).toBeUndefined();
    expect(last.consumptionSeconds).toBe(Math.round(6.98 * 3600));
  });

  it('ignores the average column, which is derivable and disagrees', () => {
    const r = parseSpotifyReport(`${SHOW}_Engagement_all-time.csv`, ENGAGEMENT);
    expect(r.unknownHeadings).toEqual([]);
    expect(Object.keys(r.rows[0])).not.toContain('averageConsumptionSeconds');
  });

  it('flags a window that spans the play-definition change', () => {
    const r = parseSpotifyReport(`${SHOW}_Performance_all-time.csv`, PERFORMANCE);
    expect(r.straddlesDefinitionChange).toBe(true);
    const after = parseSpotifyReport(`${SHOW}_DailyImpressions_x.csv`, IMPRESSIONS);
    expect(after.straddlesDefinitionChange).toBe(false);
  });

  it('converts consumption hours to whole seconds', () => {
    const r = parseSpotifyReport(`${SHOW}_Engagement_all-time.csv`, ENGAGEMENT);
    expect(r.rows[0].consumptionSeconds).toBe(1584); // 0.44h
  });
});

describe('demographic distributions', () => {
  it('reads the gender split', () => {
    const r = parseSpotifyReport(`${SHOW}_AreEvalsDead_Gender_all-time.csv`, GENDER);
    expect(r.identity.series).toBe('distribution');
    expect(r.demographics).toHaveLength(4);
    const male = r.demographics.find((d) => d.genderBucket === 'male');
    expect(male!.percentage).toBeCloseTo(76.678, 3);
    expect(r.demographics.reduce((a, d) => a + d.percentage, 0)).toBeCloseTo(100, 6);
  });

  it('reads the age-by-gender matrix as cells plus age marginals', () => {
    const r = parseSpotifyReport(`${SHOW}_AreEvalsDead_AgeByGender_all-time.csv`, AGE_BY_GENDER);
    // Two age rows: one 'age' marginal plus four gendered cells each.
    expect(r.demographics).toHaveLength(10);
    const marg = r.demographics.filter((d) => d.dimension === 'age');
    expect(marg).toHaveLength(2);
    const row = r.demographics.filter((d) => d.ageBucket === '35-44' && d.dimension === 'age_by_gender');
    const sum = row.reduce((a, d) => a + d.percentage, 0);
    // The gendered cells reconcile to the row marginal, which is how we know
    // the matrix was read the right way round.
    expect(sum).toBeCloseTo(marg.find((d) => d.ageBucket === '35-44')!.percentage, 6);
  });

  it('has no unknown headings on either demographic file', () => {
    expect(parseSpotifyReport(`${SHOW}_x_Gender_all-time.csv`, GENDER).unknownHeadings).toEqual([]);
    expect(parseSpotifyReport(`${SHOW}_x_AgeByGender_all-time.csv`, AGE_BY_GENDER).unknownHeadings).toEqual([]);
  });
});

describe('matchEpisodeSlug', () => {
  const eps = [
    { id: 'a', title: 'Are Evals Dead?', publish_date: '2025-09-26T00:00:00Z' },
    { id: 'b', title: 'Are Evals Dead? Part Two', publish_date: '2025-10-03T00:00:00Z' },
    { id: 'c', title: 'Something Else', publish_date: '2024-01-01T00:00:00Z' },
  ];

  it('matches the exact title even when another title extends it', () => {
    expect(matchEpisodeSlug('AreEvalsDead', eps).episode!.id).toBe('a');
  });

  it('matches a longer slug to the episode that extends it', () => {
    const r = matchEpisodeSlug('AreEvalsDeadPart', eps);
    expect(r.episode!.id).toBe('b');
    expect(r.reason).toMatch(/prefix/);
  });

  it('uses the publish date when two episodes share a title', () => {
    // A re-release reuses the title, so the slug alone cannot separate them.
    // A "since-published" export starts on the day the episode went out.
    const twins = [
      { id: 'x', title: 'Agents in Production', publish_date: '2024-05-01T00:00:00Z' },
      { id: 'y', title: 'Agents in Production', publish_date: '2026-02-11T00:00:00Z' },
    ];
    const r = matchEpisodeSlug('AgentsInProduction', twins, { firstDay: '2026-02-11' });
    expect(r.episode!.id).toBe('y');
    expect(r.reason).toMatch(/publish date/);

    // And without a date to go on, it refuses.
    expect(matchEpisodeSlug('AgentsInProduction', twins).episode).toBeNull();
  });

  it('refuses rather than guessing when the slug is ambiguous', () => {
    const r = matchEpisodeSlug('AreEvals', eps);
    expect(r.episode).toBeNull();
    expect(r.reason).toMatch(/refusing to guess/);
  });

  it('refuses a slug that matches nothing', () => {
    expect(matchEpisodeSlug('NotAnEpisode', eps).episode).toBeNull();
  });
});

describe('the basics', () => {
  it('parses quoted fields with commas', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
    expect(parseCsvLine('"say ""hi""",2')).toEqual(['say "hi"', '2']);
  });

  it('parses US dates in UTC so the day does not shift', () => {
    expect(parseDay('3/23/2020')).toBe('2020-03-23');
    expect(parseDay('10/5/2026')).toBe('2026-10-05');
    expect(parseDay('2026-10-05')).toBe('2026-10-05');
    expect(parseDay('nonsense')).toBeNull();
    expect(parseDay('')).toBeNull();
  });

  it('refuses a file with no date column', () => {
    const r = parseSpotifyReport('Show_Performance_x.csv', 'Foo,Bar\n1,2');
    expect(r.refused).toBeTruthy();
  });
});
