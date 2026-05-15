/**
 * Three-up stats — large number + label, presented horizontally.
 * "Look how much we've grown" social proof / metrics dashboard.
 */

import { Column, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface StatsThreeUpProps extends Record<string, unknown> {
  s1_value: string;
  s1_label: string;
  s2_value: string;
  s2_label: string;
  s3_value: string;
  s3_label: string;
  accent_color: string;
}

function StatCell({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <Column style={{ width: 'calc(100% / 3)', verticalAlign: 'top', textAlign: 'center', padding: '0 8px' }}>
      <Text style={{ margin: '0 0 4px', fontSize: 36, fontWeight: 700, color, lineHeight: '1.1' }}>{value}</Text>
      <Text style={{ margin: 0, fontSize: 12, color: '#6B7280', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</Text>
    </Column>
  );
}

export const StatsThreeUpBlock: EmailBlockEntry<StatsThreeUpProps> = {
  componentId: 'stats_three_up',
  label: 'Stats (three up)',
  category: 'Stats',
  fields: {
    s1_value: { type: 'text', label: 'Stat 1 — value' },
    s1_label: { type: 'text', label: 'Stat 1 — label' },
    s2_value: { type: 'text', label: 'Stat 2 — value' },
    s2_label: { type: 'text', label: 'Stat 2 — label' },
    s3_value: { type: 'text', label: 'Stat 3 — value' },
    s3_label: { type: 'text', label: 'Stat 3 — label' },
    accent_color: { type: 'text', label: 'Accent colour' },
  },
  defaultProps: {
    s1_value: '120K+',
    s1_label: 'Active users',
    s2_value: '99.9%',
    s2_label: 'Uptime',
    s3_value: '50ms',
    s3_label: 'P99 latency',
    accent_color: '#2563EB',
  },
  Component: (p) => (
    <Section style={{ padding: '32px 0' }}>
      <Row>
        <StatCell value={p.s1_value} label={p.s1_label} color={p.accent_color} />
        <StatCell value={p.s2_value} label={p.s2_label} color={p.accent_color} />
        <StatCell value={p.s3_value} label={p.s3_label} color={p.accent_color} />
      </Row>
    </Section>
  ),
};
