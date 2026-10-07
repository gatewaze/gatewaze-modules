import { describe, it, expect } from 'vitest';
import { deriveJoinState, hasJoinFlag, parseChannels, RESEND_AFTER_MS, type MyInvitations } from '../components/_lib/joinState';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const inv = (outcome: MyInvitations['invitations'][number]['outcome'], email = 'a@example.com', at: string | null = '2026-10-06T11:00:00Z') => ({
  email,
  outcome,
  invited_at: outcome === 'sent' ? at : null,
  requested_at: '2026-10-06T10:00:00Z',
  updated_at: at ?? '2026-10-06T10:00:00Z',
});
const data = (invitations: MyInvitations['invitations'], emails = ['a@example.com']): MyInvitations => ({
  emails: emails.map((email, i) => ({ email, is_primary: i === 0 })),
  invitations,
});

describe('deriveJoinState', () => {
  it('is ready with the account addresses when nothing was requested', () => {
    expect(deriveJoinState(data([], ['a@example.com', 'b@example.com']), NOW)).toEqual({ kind: 'ready', emails: ['a@example.com', 'b@example.com'] });
  });

  it('treats missing data as ready with no addresses', () => {
    expect(deriveJoinState(null, NOW)).toEqual({ kind: 'ready', emails: [] });
  });

  it('shows an in-flight invitation as queued', () => {
    expect(deriveJoinState(data([inv('queued')]), NOW)).toEqual({ kind: 'queued', email: 'a@example.com' });
  });

  it('a sent invitation younger than the dedupe window cannot be resent', () => {
    const s = deriveJoinState(data([inv('sent')]), NOW);
    expect(s.kind).toBe('sent');
    expect(s).toMatchObject({ email: 'a@example.com', canResend: false, at: '2026-10-06T11:00:00Z' });
  });

  it('a sent invitation older than the dedupe window can be resent', () => {
    const old = new Date(NOW - RESEND_AFTER_MS - 1000).toISOString();
    expect(deriveJoinState(data([inv('sent', 'a@example.com', old)]), NOW)).toMatchObject({ kind: 'sent', canResend: true });
  });

  it('membership wins over everything else', () => {
    expect(deriveJoinState(data([inv('queued', 'b@example.com'), inv('member')]), NOW)).toEqual({ kind: 'member', email: 'a@example.com' });
  });

  it('queued wins over sent and failed', () => {
    expect(deriveJoinState(data([inv('failed'), inv('sent', 'b@example.com'), inv('queued', 'c@example.com')]), NOW).kind).toBe('queued');
  });

  it('a failure offers the addresses to retry with', () => {
    expect(deriveJoinState(data([inv('failed')], ['a@example.com', 'b@example.com']), NOW)).toEqual({
      kind: 'failed', email: 'a@example.com', emails: ['a@example.com', 'b@example.com'],
    });
  });
});

describe('parseChannels', () => {
  it('splits on commas and newlines, trims and strips the hash', () => {
    expect(parseChannels('general, #introduce-yourself \njob-posts,,')).toEqual(['general', 'introduce-yourself', 'job-posts']);
  });
  it('handles empty config', () => {
    expect(parseChannels(null)).toEqual([]);
    expect(parseChannels('')).toEqual([]);
  });
});

describe('hasJoinFlag', () => {
  it('reads join=1 from the query string', () => {
    expect(hasJoinFlag('?join=1')).toBe(true);
    expect(hasJoinFlag('?join=0')).toBe(false);
    expect(hasJoinFlag('')).toBe(false);
    expect(hasJoinFlag(null)).toBe(false);
  });
});
