/**
 * Pull quote — large indented quote with optional attribution. Variant
 * of the bare `Text` primitive: same data shape but styled as a quote
 * block (left rule + italic + larger).
 */

import { Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface PullQuoteProps extends Record<string, unknown> {
  quote: string;
  attribution: string;
  accent_color: string;
}

export const PullQuoteBlock: EmailBlockEntry<PullQuoteProps> = {
  componentId: 'pull_quote',
  label: 'Pull quote',
  category: 'Content',
  fields: {
    quote: { type: 'textarea', label: 'Quote', contentEditable: true },
    attribution: { type: 'text', label: 'Attribution (optional)', contentEditable: true },
    accent_color: { type: 'text', label: 'Accent colour (left rule)' },
  },
  defaultProps: {
    quote: 'The best way to predict the future is to invent it.',
    attribution: 'Alan Kay',
    accent_color: '#2563EB',
  },
  Component: ({ quote, attribution, accent_color }) => (
    <Section style={{ padding: '24px 0' }}>
      <div style={{ paddingLeft: 20, borderLeft: `4px solid ${accent_color}` }}>
        <Text style={{ margin: 0, fontSize: 20, fontStyle: 'italic', color: '#111827', lineHeight: '1.5' }}>
          “{quote}”
        </Text>
        {attribution ? (
          <Text style={{ margin: '12px 0 0', fontSize: 14, color: '#6B7280' }}>
            — {attribution}
          </Text>
        ) : null}
      </div>
    </Section>
  ),
};
