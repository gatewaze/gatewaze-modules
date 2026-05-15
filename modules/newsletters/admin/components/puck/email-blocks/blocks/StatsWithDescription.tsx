/**
 * Single big stat with surrounding description. Suited for headline
 * announcements like "1M signups in 30 days".
 */

import { Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface StatsWithDescriptionProps extends Record<string, unknown> {
  value: string;
  label: string;
  description: string;
  accent_color: string;
}

export const StatsWithDescriptionBlock: EmailBlockEntry<StatsWithDescriptionProps> = {
  componentId: 'stat_with_description',
  label: 'Stat with description',
  category: 'Stats',
  fields: {
    value: { type: 'text', label: 'Value', contentEditable: true },
    label: { type: 'text', label: 'Label' },
    description: { type: 'textarea', label: 'Description' },
    accent_color: { type: 'text', label: 'Accent colour' },
  },
  defaultProps: {
    value: '1M+',
    label: 'New signups in the last 30 days',
    description: 'We hit a milestone — thanks to everyone who joined and to the team that made it possible.',
    accent_color: '#10B981',
  },
  Component: ({ value, label, description, accent_color }) => (
    <Section style={{ padding: '40px 24px', textAlign: 'center' }}>
      <Text style={{ margin: '0 0 8px', fontSize: 56, fontWeight: 800, color: accent_color, lineHeight: '1.1' }}>
        {value}
      </Text>
      <Text style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600, color: '#111827' }}>{label}</Text>
      <Text style={{ margin: 0, fontSize: 14, color: '#4B5563', lineHeight: '1.5', maxWidth: 480 }}>
        {description}
      </Text>
    </Section>
  ),
};
