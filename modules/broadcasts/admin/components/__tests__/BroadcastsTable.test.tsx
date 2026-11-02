// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BroadcastsTable } from '../BroadcastsTable.js';
import type { Broadcast } from '../../lib/broadcastService.js';

vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }));
vi.mock('../../lib/broadcastService.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/broadcastService.js')>('../../lib/broadcastService.js');
  return {
    ...actual,
    broadcastEngagement: vi.fn().mockResolvedValue([]),
    deleteBroadcast: vi.fn(),
  };
});

function makeBroadcast(overrides: Partial<Broadcast>): Broadcast {
  return {
    id: 'b1',
    name: 'Fall Launch Internal',
    brand: 'gatewaze',
    channel: 'email',
    slack_sender: 'bot',
    audience_type: 'segment',
    segment_id: null,
    list_ids: [],
    category_list_id: null,
    include_prospects: false,
    event_id: null,
    forward_replies_to: null,
    subject: 'Fall Launch — 20% off',
    preheader: null,
    from_address: null,
    from_name: null,
    reply_to: null,
    rendered_html: null,
    body_text: null,
    content_json: {},
    created_by: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    sends: [],
    ...overrides,
  };
}

describe('BroadcastsTable', () => {
  afterEach(cleanup);

  it('labels a Slack broadcast and counts its sent messages from its sends', async () => {
    const broadcast = makeBroadcast({
      id: 'b9', name: 'VAF Slack', channel: 'slack', subject: 'VAF Slack',
      sends: [{
        id: 's9', broadcast_id: 'b9', status: 'sent', schedule_type: 'immediate', delivery_strategy: 'global',
        scheduled_at: null, started_at: null, completed_at: null, total_recipients: 0, sent_count: 1234, failed_count: 0,
        created_at: '2026-10-29T00:00:00Z',
      }],
    });
    render(<BroadcastsTable broadcasts={[broadcast]} />);
    expect(screen.getByText('Slack message')).toBeTruthy();
    expect(await screen.findByText('1,234')).toBeTruthy();
  });

  it('shows the header label for the new Name column', () => {
    render(<BroadcastsTable broadcasts={[makeBroadcast({})]} />);
    expect(screen.getByText('Name')).toBeTruthy();
  });

  it('renders name and subject as independent columns, not a fallback', () => {
    const broadcast = makeBroadcast({
      id: 'b2',
      name: 'Fall Launch Internal',
      subject: 'Fall Launch — 20% off',
    });
    render(<BroadcastsTable broadcasts={[broadcast]} />);
    expect(screen.getByText('Fall Launch Internal')).toBeTruthy();
    expect(screen.getByText('Fall Launch — 20% off')).toBeTruthy();
  });

  it('shows the name and the "No subject" placeholder when subject is null (no fallback to name)', () => {
    const broadcast = makeBroadcast({ id: 'b3', name: 'Draft Without Subject', subject: null });
    render(<BroadcastsTable broadcasts={[broadcast]} />);
    expect(screen.getByText('Draft Without Subject')).toBeTruthy();
    expect(screen.getByText('No subject')).toBeTruthy();
    // The name must not appear a second time standing in for the subject.
    expect(screen.getAllByText('Draft Without Subject')).toHaveLength(1);
  });

  it('still renders status badge and formatted date alongside the new column', () => {
    const broadcast = makeBroadcast({
      id: 'b4',
      name: 'Status Check',
      created_at: '2026-08-15T00:00:00Z',
      sends: [
        {
          id: 's1',
          broadcast_id: 'b4',
          status: 'sent',
          schedule_type: 'immediate',
          delivery_strategy: 'global',
          scheduled_at: null,
          started_at: null,
          completed_at: '2026-08-15T00:00:00Z',
          total_recipients: 10,
          sent_count: 10,
          failed_count: 0,
          created_at: '2026-08-15T00:00:00Z',
        },
      ],
    });
    render(<BroadcastsTable broadcasts={[broadcast]} />);
    // "Sent" appears both as the status badge and the metrics column header.
    expect(screen.getAllByText('Sent').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Aug 15, 2026')).toBeTruthy();
  });
});
