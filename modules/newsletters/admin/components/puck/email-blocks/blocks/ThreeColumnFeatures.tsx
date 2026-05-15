/**
 * Three-column features grid — icon + title + body per column.
 * Three-up companion to the existing TwoColumnFeatures block.
 */

import { Column, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface ThreeColumnFeaturesProps extends Record<string, unknown> {
  heading: string;
  col_1_icon: string;
  col_1_title: string;
  col_1_body: string;
  col_2_icon: string;
  col_2_title: string;
  col_2_body: string;
  col_3_icon: string;
  col_3_title: string;
  col_3_body: string;
}

function Feature({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <Column style={{ verticalAlign: 'top', padding: '0 8px', width: 'calc(100% / 3)' }}>
      <Text style={{ margin: '0 0 12px', fontSize: 32, lineHeight: '1.2' }}>{icon}</Text>
      <Text style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600, color: '#111827' }}>{title}</Text>
      <Text style={{ margin: 0, fontSize: 13, color: '#4B5563', lineHeight: '1.5' }}>{body}</Text>
    </Column>
  );
}

export const ThreeColumnFeaturesBlock: EmailBlockEntry<ThreeColumnFeaturesProps> = {
  componentId: 'three_column_features',
  label: 'Three-column features',
  category: 'Features',
  fields: {
    heading: { type: 'text', label: 'Section heading' },
    col_1_icon: { type: 'text', label: 'Column 1 — icon (emoji)' },
    col_1_title: { type: 'text', label: 'Column 1 — title' },
    col_1_body: { type: 'textarea', label: 'Column 1 — body' },
    col_2_icon: { type: 'text', label: 'Column 2 — icon' },
    col_2_title: { type: 'text', label: 'Column 2 — title' },
    col_2_body: { type: 'textarea', label: 'Column 2 — body' },
    col_3_icon: { type: 'text', label: 'Column 3 — icon' },
    col_3_title: { type: 'text', label: 'Column 3 — title' },
    col_3_body: { type: 'textarea', label: 'Column 3 — body' },
  },
  defaultProps: {
    heading: 'What you get',
    col_1_icon: '⚡',
    col_1_title: 'Fast setup',
    col_1_body: 'Get started in minutes, not hours.',
    col_2_icon: '🛡️',
    col_2_title: 'Secure by default',
    col_2_body: 'Built-in protections you don\'t need to configure.',
    col_3_icon: '📊',
    col_3_title: 'Real-time insights',
    col_3_body: 'See exactly what\'s happening across your stack.',
  },
  Component: (p) => (
    <Section style={{ padding: '32px 0' }}>
      {p.heading ? (
        <Text style={{ margin: '0 0 24px', fontSize: 22, fontWeight: 700, color: '#111827', textAlign: 'center' }}>
          {p.heading}
        </Text>
      ) : null}
      <Row>
        <Feature icon={p.col_1_icon} title={p.col_1_title} body={p.col_1_body} />
        <Feature icon={p.col_2_icon} title={p.col_2_title} body={p.col_2_body} />
        <Feature icon={p.col_3_icon} title={p.col_3_title} body={p.col_3_body} />
      </Row>
    </Section>
  ),
};
