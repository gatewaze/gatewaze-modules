/**
 * Divider with an inline label — visual section break with a short
 * caption centred on the rule. The bare `Hr` covers the no-label case;
 * this is the labelled variant.
 */

import { Column, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface LabeledDividerProps extends Record<string, unknown> {
  label: string;
  color: string;
}

export const LabeledDividerBlock: EmailBlockEntry<LabeledDividerProps> = {
  componentId: 'labeled_divider',
  label: 'Divider with label',
  category: 'Layout',
  fields: {
    label: { type: 'text', label: 'Label' },
    color: { type: 'text', label: 'Line + label colour' },
  },
  defaultProps: {
    label: 'OR',
    color: '#9CA3AF',
  },
  Component: ({ label, color }) => (
    <Section style={{ padding: '16px 0' }}>
      <Row>
        <Column style={{ verticalAlign: 'middle' }}>
          <div style={{ borderTop: `1px solid ${color}`, lineHeight: 0, fontSize: 0 }}>&nbsp;</div>
        </Column>
        <Column style={{ width: 60, verticalAlign: 'middle', textAlign: 'center' }}>
          <Text style={{ margin: 0, fontSize: 11, color, letterSpacing: 1, textTransform: 'uppercase' }}>
            {label}
          </Text>
        </Column>
        <Column style={{ verticalAlign: 'middle' }}>
          <div style={{ borderTop: `1px solid ${color}`, lineHeight: 0, fontSize: 0 }}>&nbsp;</div>
        </Column>
      </Row>
    </Section>
  ),
};
