/**
 * Title matching against an agenda and the metadata we keep from yt-dlp
 * (lib/agenda-match.ts).
 */

import { describe, it, expect } from 'vitest';
import { matchAgendaByTitle, metaFromInfoJson } from '../lib/agenda-match.js';

const agenda = [
  { id: 'a1', title: 'Giving Your Agentic Coding AI a Security Brain' },
  { id: 'a2', title: 'Pull Requests Are Dead, Long Live Peer Review' },
  { id: 'a3', title: 'Keynote' },
  { id: 'a4', title: 'Governed Agent Autonomy: Building a Control Plane for Agentic Systems' },
  { id: 'a5', title: 'Governed Agent Autonomy' },
];

describe('matchAgendaByTitle', () => {
  it('matches a decorated YouTube title to the plain agenda title', () => {
    expect(matchAgendaByTitle('Pull Requests Are Dead, Long Live Peer Review - Dylan Ratcliff | AGNTCon EU', agenda)?.id).toBe('a2');
    expect(matchAgendaByTitle('Security Track: giving your agentic coding AI a security brain', agenda)?.id).toBe('a1');
  });

  it('refuses when two agenda entries fit', () => {
    // 'Governed Agent Autonomy' is inside the longer title as well, so both fit.
    expect(matchAgendaByTitle('Governed Agent Autonomy: Building a Control Plane for Agentic Systems', agenda)).toBeNull();
  });

  it('ignores generic titles in either direction', () => {
    expect(matchAgendaByTitle('Keynote', agenda)).toBeNull();
    expect(matchAgendaByTitle('Day 2 Keynote with somebody', agenda)).toBeNull();
  });

  it('is null when nothing fits', () => {
    expect(matchAgendaByTitle('AGNTCon EU 2026 full livestream day 1', agenda)).toBeNull();
  });
});

describe('metaFromInfoJson', () => {
  it('keeps title, description, duration, date and chapters', () => {
    const m = metaFromInfoJson({
      title: ' Scaling Agents ', description: 'desc', duration: 1382.4, upload_date: '20260918',
      chapters: [{ title: 'Intro', start_time: 0, end_time: 60 }, { title: '', start_time: 60, end_time: 90 }, { title: 'Bad', start_time: 90, end_time: 80 }],
      formats: [{ huge: true }],
    });
    expect(m).toEqual({
      title: 'Scaling Agents', description: 'desc', durationSeconds: 1382, publishedAt: '2026-09-18T00:00:00.000Z',
      chapters: [{ title: 'Intro', start: 0, end: 60 }],
    });
  });

  it('prefers a release timestamp over the upload date', () => {
    expect(metaFromInfoJson({ release_timestamp: 1_758_200_000, upload_date: '20260918' }).publishedAt).toBe('2025-09-18T12:53:20.000Z');
  });

  it('drops a date or duration Postgres would refuse', () => {
    expect(metaFromInfoJson({ upload_date: '99999999' }).publishedAt).toBeNull();
    expect(metaFromInfoJson({ upload_date: '20260231' }).publishedAt).toBeNull();
    expect(metaFromInfoJson({ timestamp: 9e15 }).publishedAt).toBeNull();
    expect(metaFromInfoJson({ duration: 1e12 }).durationSeconds).toBeNull();
  });

  it('survives garbage', () => {
    expect(metaFromInfoJson(null)).toEqual({ title: null, description: null, durationSeconds: null, publishedAt: null, chapters: [] });
    expect(metaFromInfoJson({ title: 42, duration: -1, chapters: 'no' }).chapters).toEqual([]);
  });
});
