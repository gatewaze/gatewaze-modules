/**
 * Single-row feature with leading icon — icon on the left, title +
 * body on the right. Repeat multiple instances for a feature list.
 */

import { Column, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface FeatureRowWithIconProps extends Record<string, unknown> {
  icon: string;
  icon_bg: string;
  title: string;
  body: string;
}

export const FeatureRowWithIconBlock: EmailBlockEntry<FeatureRowWithIconProps> = {
  componentId: 'feature_row_with_icon',
  label: 'Feature row (with icon)',
  category: 'Features',
  fields: {
    icon: { type: 'text', label: 'Icon (emoji)' },
    icon_bg: { type: 'text', label: 'Icon background' },
    title: { type: 'text', label: 'Title', contentEditable: true },
    body: { type: 'textarea', label: 'Body', contentEditable: true },
  },
  defaultProps: {
    icon: '🚀',
    icon_bg: '#EFF6FF',
    title: 'A standout feature',
    body: 'A sentence or two describing why this feature matters to readers.',
  },
  Component: ({ icon, icon_bg, title, body }) => (
    <Section style={{ padding: '16px 0' }}>
      <Row>
        <Column style={{ width: 64, verticalAlign: 'top' }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 8,
              backgroundColor: icon_bg,
              textAlign: 'center',
              fontSize: 24,
              lineHeight: '48px',
            }}
          >
            {icon}
          </div>
        </Column>
        <Column style={{ verticalAlign: 'top', paddingLeft: 12 }}>
          <Text style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: '#111827' }}>{title}</Text>
          <Text style={{ margin: 0, fontSize: 14, color: '#4B5563', lineHeight: '1.5' }}>{body}</Text>
        </Column>
      </Row>
    </Section>
  ),
};
