import { describe, expect, it } from 'vitest';
import {
  assertNoPiiInRendered,
  buildEditionDirName,
  buildEditionPublishFiles,
  buildSnapshotPublishFiles,
} from '../edition-writer.js';

describe('PII boundary — assertNoPiiInRendered', () => {
  it('passes HTML with merge-tag placeholders intact', () => {
    expect(() => assertNoPiiInRendered('Hi {{first_name}}, welcome to {{list_name}}.')).not.toThrow();
  });

  it('passes HTML with no PII at all', () => {
    expect(() => assertNoPiiInRendered('<p>This week we shipped feature X.</p>')).not.toThrow();
  });

  it('rejects HTML containing a real email address', () => {
    expect(() => assertNoPiiInRendered('Hi Dan, your email dan@example.com was added.'))
      .toThrow(/PII boundary violation/);
  });

  it('rejects HTML with sendgrid recipient id leaked', () => {
    expect(() => assertNoPiiInRendered('<p>SENDGRID_RECIPIENT_ID: 12345</p>'))
      .toThrow(/PII boundary violation/);
  });

  it('strips merge tags before scanning so {{email}} placeholder is allowed', () => {
    expect(() => assertNoPiiInRendered('Your address: {{email}}')).not.toThrow();
  });
});

describe('buildEditionDirName', () => {
  it('produces YYYY-MM-DD-HHMM-slug format', () => {
    const dir = buildEditionDirName({
      sentAt: '2026-05-03T09:30:00Z',
      subject: 'Monthly News',
    } as Parameters<typeof buildEditionDirName>[0]);
    expect(dir).toBe('2026-05-03-0930-monthly-news');
  });

  it('time-qualifies same-day same-name editions to avoid collision', () => {
    const morning = buildEditionDirName({ sentAt: '2026-05-03T09:00:00Z', subject: 'News' } as Parameters<typeof buildEditionDirName>[0]);
    const afternoon = buildEditionDirName({ sentAt: '2026-05-03T14:30:00Z', subject: 'News (correction)' } as Parameters<typeof buildEditionDirName>[0]);
    expect(morning).not.toEqual(afternoon);
    expect(morning).toBe('2026-05-03-0900-news');
    expect(afternoon).toBe('2026-05-03-1430-news-correction');
  });

  it('caps slug at 60 chars', () => {
    const dir = buildEditionDirName({
      sentAt: '2026-05-03T09:00:00Z',
      subject: 'A'.repeat(100),
    } as Parameters<typeof buildEditionDirName>[0]);
    // Slug part is everything after YYYY-MM-DD-HHMM- (16 chars including trailing dash)
    expect(dir.length).toBeLessThanOrEqual(16 + 60);
  });
});

describe('buildEditionPublishFiles', () => {
  it('writes 4 files under the edition dir + tag', () => {
    const result = buildEditionPublishFiles({
      editionId: '01HXY',
      listId: 'list-1',
      listSlug: 'monthly',
      subject: 'May Edition',
      renderedHtml: '<p>Hi {{first_name}}</p>',
      renderedText: 'Hi {{first_name}}',
      content: { headline: 'Welcome' },
      sentAt: '2026-05-03T09:00:00Z',
      sender: 'AAIF News <news@aaif.org>',
      templateSha: 'abc1234',
      sendCount: 1200,
    });
    expect(result.tag).toBe('edition/2026-05-03-0900-may-edition');
    expect([...result.files.keys()].sort()).toEqual([
      'editions/2026-05-03-0900-may-edition/content.json',
      'editions/2026-05-03-0900-may-edition/metadata.json',
      'editions/2026-05-03-0900-may-edition/rendered.html',
      'editions/2026-05-03-0900-may-edition/rendered.txt',
    ]);
    const meta = JSON.parse(result.files.get('editions/2026-05-03-0900-may-edition/metadata.json') as string);
    expect(meta).toMatchObject({ status: 'sent', send_count: 1200, subject: 'May Edition' });
  });

  it('refuses to write when rendered HTML contains real PII', () => {
    expect(() =>
      buildEditionPublishFiles({
        editionId: '01',
        listId: 'list-1',
        listSlug: 'l',
        subject: 'Test',
        renderedHtml: '<p>Hi Dan, dan@example.com</p>',
        renderedText: 'Hi Dan',
        content: {},
        sentAt: '2026-05-03T09:00:00Z',
        sender: 'x',
        templateSha: 'y',
        sendCount: 0,
      }),
    ).toThrow(/PII boundary violation/);
  });
});

describe('buildSnapshotPublishFiles', () => {
  it('writes only metadata.json with status=closed + final_stats', () => {
    const result = buildSnapshotPublishFiles(
      {
        editionId: '01HXY',
        finalStats: { sent: 1200, delivered: 1185, opened: 450, clicked: 87, bounced: 15, complained: 2 },
        snapshotAt: '2026-05-09T09:00:00Z',
      },
      {
        sentAt: '2026-05-03T09:00:00Z',
        listSlug: 'monthly',
        subject: 'May Edition',
        sender: 'x',
        templateSha: 'y',
        sendCount: 1200,
      },
    );
    expect([...result.files.keys()]).toEqual([
      'editions/2026-05-03-0900-may-edition/metadata.json',
    ]);
    const meta = JSON.parse(result.files.get('editions/2026-05-03-0900-may-edition/metadata.json') as string);
    expect(meta.status).toBe('closed');
    expect(meta.final_stats.opened).toBe(450);
    expect(meta.snapshot_at).toBe('2026-05-09T09:00:00Z');
  });
});
