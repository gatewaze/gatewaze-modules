/**
 * 2×2 feature grid — four mini-features arranged as a square. Common
 * in product launch announcements with multiple highlight points.
 */

import { Column, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface FeatureGridProps extends Record<string, unknown> {
  heading: string;
  f1_icon: string;
  f1_title: string;
  f1_body: string;
  f2_icon: string;
  f2_title: string;
  f2_body: string;
  f3_icon: string;
  f3_title: string;
  f3_body: string;
  f4_icon: string;
  f4_title: string;
  f4_body: string;
}

function GridCell({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <Column style={{ width: '50%', verticalAlign: 'top', padding: '16px' }}>
      <Text style={{ margin: '0 0 8px', fontSize: 24 }}>{icon}</Text>
      <Text style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#111827' }}>{title}</Text>
      <Text style={{ margin: 0, fontSize: 13, color: '#6B7280', lineHeight: '1.5' }}>{body}</Text>
    </Column>
  );
}

export const FeatureGridBlock: EmailBlockEntry<FeatureGridProps> = {
  componentId: 'feature_grid_2x2',
  label: 'Feature grid (2×2)',
  category: 'Features',
  fields: {
    heading: { type: 'text', label: 'Section heading' },
    f1_icon: { type: 'text', label: 'F1 icon' },
    f1_title: { type: 'text', label: 'F1 title' },
    f1_body: { type: 'textarea', label: 'F1 body' },
    f2_icon: { type: 'text', label: 'F2 icon' },
    f2_title: { type: 'text', label: 'F2 title' },
    f2_body: { type: 'textarea', label: 'F2 body' },
    f3_icon: { type: 'text', label: 'F3 icon' },
    f3_title: { type: 'text', label: 'F3 title' },
    f3_body: { type: 'textarea', label: 'F3 body' },
    f4_icon: { type: 'text', label: 'F4 icon' },
    f4_title: { type: 'text', label: 'F4 title' },
    f4_body: { type: 'textarea', label: 'F4 body' },
  },
  defaultProps: {
    heading: 'Everything in the box',
    f1_icon: '🚀',
    f1_title: 'Fast',
    f1_body: 'Production-ready in under five minutes.',
    f2_icon: '🔒',
    f2_title: 'Secure',
    f2_body: 'Encrypted at rest and in transit.',
    f3_icon: '📊',
    f3_title: 'Observable',
    f3_body: 'Built-in metrics + structured logs.',
    f4_icon: '⚙️',
    f4_title: 'Configurable',
    f4_body: 'Sensible defaults, deep customisation.',
  },
  Component: (p) => (
    <Section style={{ padding: '32px 0' }}>
      {p.heading ? (
        <Text style={{ margin: '0 0 16px', fontSize: 22, fontWeight: 700, color: '#111827', textAlign: 'center' }}>
          {p.heading}
        </Text>
      ) : null}
      <Row>
        <GridCell icon={p.f1_icon} title={p.f1_title} body={p.f1_body} />
        <GridCell icon={p.f2_icon} title={p.f2_title} body={p.f2_body} />
      </Row>
      <Row>
        <GridCell icon={p.f3_icon} title={p.f3_title} body={p.f3_body} />
        <GridCell icon={p.f4_icon} title={p.f4_title} body={p.f4_body} />
      </Row>
    </Section>
  ),
};
