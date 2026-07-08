/**
 * Local Events email block — per-recipient list of upcoming in-person events
 * near the reader. Location-dependent, resolved at SEND time (event data is
 * live, and editions are authored ahead of the send).
 *
 * Two render paths share one component (the Weather.tsx pattern):
 *
 *   - **Editor preview** (`editMode === true`): renders a representative static
 *     sample so the author sees the block's shape, with a note that each reader
 *     gets their own nearby events.
 *
 *   - **Publish** (`editMode === false`): emits a single self-contained token
 *     `{{local_events_block}}` plus a hidden `<!--gw-local-events:{...}-->`
 *     config marker. The send-engine binding
 *     (workers/send-engine-binding.ts → event-personalisation.ts) resolves the
 *     token per recipient to either a rendered event list OR an empty string.
 *     Empty string ⇒ the block disappears for readers with no nearby events.
 *
 * v1 scope: matches events within `radius_miles` of the reader (or their city
 * when coordinates are unknown). "Same US state" matching is a later addition.
 */

import { Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface LocalEventsProps extends Record<string, unknown> {
  heading: string;
  intro: string;
  max_events: number;
  radius_miles: number;
}

// Keep marker JSON from prematurely closing the HTML comment.
function safe(s: string): string {
  return String(s ?? '').replace(/--+/g, '-').trim();
}

const SAMPLE = [
  { title: 'Bay Area MLOps Meetup', meta: 'Thu, Aug 6, 6:00 PM · San Francisco' },
  { title: 'LLMs in Production Workshop', meta: 'Wed, Aug 12, 9:00 AM · San Francisco' },
];

export const LocalEventsBlock: EmailBlockEntry<LocalEventsProps> = {
  componentId: 'local_events',
  label: 'Local Events (near reader)',
  category: 'Content',
  fields: {
    heading: { type: 'text', label: 'Heading' },
    intro: { type: 'textarea', label: 'Intro text (optional)' },
    max_events: { type: 'number', label: 'Max events to show' },
    radius_miles: { type: 'number', label: 'Radius (miles)' },
  },
  defaultProps: {
    heading: 'Upcoming Events Near You',
    intro: '',
    max_events: 3,
    radius_miles: 100,
  },
  Component: ({ heading, intro, max_events, radius_miles, editMode }) => {
    if (editMode) {
      return (
        <Section style={{ padding: 20, backgroundColor: '#F9FAFB', borderRadius: 10, margin: '8px 0' }}>
          <Text style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: '#111827' }}>
            {heading || 'Upcoming Events Near You'}
          </Text>
          {intro ? (
            <Text style={{ margin: '0 0 12px', fontSize: 14, color: '#374151' }}>{intro}</Text>
          ) : null}
          {SAMPLE.map((s) => (
            <Text key={s.title} style={{ margin: 0, padding: '10px 0', borderBottom: '1px solid #E5E7EB' }}>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: '#111827' }}>{s.title}</span>
              <span style={{ display: 'block', fontSize: 13, color: '#6B7280', marginTop: 2 }}>{s.meta}</span>
            </Text>
          ))}
          <Text style={{ margin: '12px 0 0', fontSize: 11, color: '#6B7280' }}>
            Each reader sees up to {max_events || 3} real events within {radius_miles || 100} miles of them, resolved at
            send time. Readers with no nearby events don’t see this block.
          </Text>
        </Section>
      );
    }

    // Publish: emit config marker + the single send-time token. Everything the
    // reader sees (heading, intro, cards) is rendered by the send pipeline from
    // the token, so a reader with no nearby events gets a truly empty block.
    const marker = `<!--gw-local-events:${JSON.stringify({
      h: safe(heading), i: safe(intro),
      m: Number(max_events) || 3, r: Number(radius_miles) || 100,
    })}-->`;
    return (
      <>
        <span dangerouslySetInnerHTML={{ __html: marker }} style={{ display: 'none' }} />
        {'{{local_events_block}}'}
      </>
    );
  },
};
