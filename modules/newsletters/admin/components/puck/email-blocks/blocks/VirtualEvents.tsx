/**
 * Virtual Events email block — list of upcoming virtual/online events. Unlike
 * Local Events, the condition is GLOBAL (same for every reader in a send), so
 * the send-engine resolves it once per send.
 *
 * Two render paths (the Weather.tsx / LocalEvents.tsx pattern):
 *
 *   - **Editor preview** (`editMode === true`): a representative static sample.
 *   - **Publish** (`editMode === false`): emits `{{virtual_events_block}}` plus
 *     a `<!--gw-virtual-events:{...}-->` marker. The send-engine binding
 *     resolves the token to a rendered list, or an empty string when there are
 *     no upcoming virtual events — in which case the block is omitted entirely.
 */

import { Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface VirtualEventsProps extends Record<string, unknown> {
  heading: string;
  intro: string;
  max_events: number;
}

function safe(s: string): string {
  return String(s ?? '').replace(/--+/g, '-').trim();
}

const SAMPLE = [
  { title: 'Virtual: Agent Evaluation Deep Dive', meta: 'Tue, Aug 5, 11:00 AM · Online' },
  { title: 'Virtual: RAG at Scale Panel', meta: 'Thu, Aug 14, 1:00 PM · Online' },
];

export const VirtualEventsBlock: EmailBlockEntry<VirtualEventsProps> = {
  componentId: 'virtual_events',
  label: 'Virtual Events',
  category: 'Content',
  fields: {
    heading: { type: 'text', label: 'Heading' },
    intro: { type: 'textarea', label: 'Intro text (optional)' },
    max_events: { type: 'number', label: 'Max events to show' },
  },
  defaultProps: {
    heading: 'Upcoming Virtual Events',
    intro: '',
    max_events: 5,
  },
  Component: ({ heading, intro, max_events, editMode }) => {
    if (editMode) {
      return (
        <Section style={{ padding: 20, backgroundColor: '#F9FAFB', borderRadius: 10, margin: '8px 0' }}>
          <Text style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: '#111827' }}>
            {heading || 'Upcoming Virtual Events'}
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
            Shows up to {max_events || 5} upcoming virtual events, resolved at send time. If there are none, this block
            is omitted.
          </Text>
        </Section>
      );
    }

    const marker = `<!--gw-virtual-events:${JSON.stringify({
      h: safe(heading), i: safe(intro), m: Number(max_events) || 5,
    })}-->`;
    return (
      <>
        <span dangerouslySetInnerHTML={{ __html: marker }} style={{ display: 'none' }} />
        {'{{virtual_events_block}}'}
      </>
    );
  },
};
