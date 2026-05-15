/**
 * Two-column preset — static content fields, not a composable slot.
 * Matches the way react.email/components' Grid snippets are shipped
 * (preset content, not arbitrary nesting). For full composability use
 * Row + 2× Column primitives.
 */

import { Column, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface TwoColumnGridProps extends Record<string, unknown> {
  left_title: string;
  left_body: string;
  right_title: string;
  right_body: string;
  gap: string;
}

export const TwoColumnGridBlock: EmailBlockEntry<TwoColumnGridProps> = {
  componentId: 'two_column_grid',
  label: 'Two-column grid',
  category: 'Layout',
  fields: {
    left_title: { type: 'text', label: 'Left title' },
    left_body: { type: 'textarea', label: 'Left body' },
    right_title: { type: 'text', label: 'Right title' },
    right_body: { type: 'textarea', label: 'Right body' },
    gap: { type: 'text', label: 'Column gap (px)' },
  },
  defaultProps: {
    left_title: 'Left title',
    left_body: 'Body copy goes here.',
    right_title: 'Right title',
    right_body: 'Body copy goes here.',
    gap: '24',
  },
  Component: ({ left_title, left_body, right_title, right_body, gap }) => {
    const half = `calc((100% - ${gap}px) / 2)`;
    const halfGap = `${Number(gap) / 2 || 12}px`;
    return (
      <Section style={{ padding: '24px 0' }}>
        <Row>
          <Column style={{ width: half, verticalAlign: 'top', paddingRight: halfGap }}>
            <Text style={{ margin: '0 0 8px', fontWeight: 600, fontSize: 18, color: '#111827' }}>{left_title}</Text>
            <Text style={{ margin: 0, fontSize: 14, color: '#4B5563' }}>{left_body}</Text>
          </Column>
          <Column style={{ width: half, verticalAlign: 'top', paddingLeft: halfGap }}>
            <Text style={{ margin: '0 0 8px', fontWeight: 600, fontSize: 18, color: '#111827' }}>{right_title}</Text>
            <Text style={{ margin: 0, fontSize: 14, color: '#4B5563' }}>{right_body}</Text>
          </Column>
        </Row>
      </Section>
    );
  },
};
