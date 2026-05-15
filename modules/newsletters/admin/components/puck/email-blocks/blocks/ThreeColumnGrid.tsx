/**
 * Three-column preset — static content fields. See TwoColumnGrid for
 * the rationale: react.email's Grid snippets are presets, not
 * composable slot containers, and the publish path currently only
 * supports a single `children` slot per block.
 */

import { Column, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface ThreeColumnGridProps extends Record<string, unknown> {
  col_1_title: string;
  col_1_body: string;
  col_2_title: string;
  col_2_body: string;
  col_3_title: string;
  col_3_body: string;
  gap: string;
}

export const ThreeColumnGridBlock: EmailBlockEntry<ThreeColumnGridProps> = {
  componentId: 'three_column_grid',
  label: 'Three-column grid',
  category: 'Layout',
  fields: {
    col_1_title: { type: 'text', label: 'Column 1 — title' },
    col_1_body: { type: 'textarea', label: 'Column 1 — body' },
    col_2_title: { type: 'text', label: 'Column 2 — title' },
    col_2_body: { type: 'textarea', label: 'Column 2 — body' },
    col_3_title: { type: 'text', label: 'Column 3 — title' },
    col_3_body: { type: 'textarea', label: 'Column 3 — body' },
    gap: { type: 'text', label: 'Column gap (px)' },
  },
  defaultProps: {
    col_1_title: 'Column 1',
    col_1_body: 'Body copy goes here.',
    col_2_title: 'Column 2',
    col_2_body: 'Body copy goes here.',
    col_3_title: 'Column 3',
    col_3_body: 'Body copy goes here.',
    gap: '16',
  },
  Component: ({ col_1_title, col_1_body, col_2_title, col_2_body, col_3_title, col_3_body, gap }) => {
    const third = `calc((100% - ${Number(gap) * 2}px) / 3)`;
    const halfGap = `${Number(gap) / 2 || 8}px`;
    return (
      <Section style={{ padding: '24px 0' }}>
        <Row>
          <Column style={{ width: third, verticalAlign: 'top', paddingRight: halfGap }}>
            <Text style={{ margin: '0 0 8px', fontWeight: 600, fontSize: 16, color: '#111827' }}>{col_1_title}</Text>
            <Text style={{ margin: 0, fontSize: 13, color: '#4B5563' }}>{col_1_body}</Text>
          </Column>
          <Column style={{ width: third, verticalAlign: 'top', padding: `0 ${halfGap}` }}>
            <Text style={{ margin: '0 0 8px', fontWeight: 600, fontSize: 16, color: '#111827' }}>{col_2_title}</Text>
            <Text style={{ margin: 0, fontSize: 13, color: '#4B5563' }}>{col_2_body}</Text>
          </Column>
          <Column style={{ width: third, verticalAlign: 'top', paddingLeft: halfGap }}>
            <Text style={{ margin: '0 0 8px', fontWeight: 600, fontSize: 16, color: '#111827' }}>{col_3_title}</Text>
            <Text style={{ margin: 0, fontSize: 13, color: '#4B5563' }}>{col_3_body}</Text>
          </Column>
        </Row>
      </Section>
    );
  },
};
