import { describe, expect, it } from 'vitest';
import { cronMatchesNow } from '../cron-handlers.js';

describe('cronMatchesNow', () => {
  it('matches * for all fields', () => {
    expect(cronMatchesNow('* * * * *', new Date('2026-05-03T09:30:00Z'))).toBe(true);
  });

  it('matches a specific minute', () => {
    expect(cronMatchesNow('30 * * * *', new Date('2026-05-03T09:30:00Z'))).toBe(true);
    expect(cronMatchesNow('30 * * * *', new Date('2026-05-03T09:31:00Z'))).toBe(false);
  });

  it('matches step expressions', () => {
    expect(cronMatchesNow('*/15 * * * *', new Date('2026-05-03T09:00:00Z'))).toBe(true);
    expect(cronMatchesNow('*/15 * * * *', new Date('2026-05-03T09:15:00Z'))).toBe(true);
    expect(cronMatchesNow('*/15 * * * *', new Date('2026-05-03T09:07:00Z'))).toBe(false);
  });

  it('matches list expressions', () => {
    expect(cronMatchesNow('0,15,30,45 * * * *', new Date('2026-05-03T09:30:00Z'))).toBe(true);
    expect(cronMatchesNow('0,15,30,45 * * * *', new Date('2026-05-03T09:31:00Z'))).toBe(false);
  });

  it('matches range expressions', () => {
    expect(cronMatchesNow('0 9-17 * * *', new Date('2026-05-03T12:00:00Z'))).toBe(true);
    expect(cronMatchesNow('0 9-17 * * *', new Date('2026-05-03T18:00:00Z'))).toBe(false);
  });

  it('rejects malformed expressions', () => {
    expect(cronMatchesNow('* *', new Date())).toBe(false);
    expect(cronMatchesNow('', new Date())).toBe(false);
  });

  it('matches Monday 9am UTC weekly schedule', () => {
    // 2026-05-04 is a Monday
    expect(cronMatchesNow('0 9 * * 1', new Date('2026-05-04T09:00:00Z'))).toBe(true);
    expect(cronMatchesNow('0 9 * * 1', new Date('2026-05-05T09:00:00Z'))).toBe(false);
  });
});
