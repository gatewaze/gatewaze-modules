/**
 * Shipping tracker — four-stage progress strip (Ordered → Packed →
 * Shipped → Delivered) with the current stage highlighted.
 */

import { Column, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface ShippingTrackerProps extends Record<string, unknown> {
  current_stage: '1' | '2' | '3' | '4';
  stage_1_label: string;
  stage_2_label: string;
  stage_3_label: string;
  stage_4_label: string;
  accent_color: string;
  eta_text: string;
}

function Step({ label, active, color }: { label: string; active: boolean; color: string }) {
  return (
    <Column style={{ width: '25%', textAlign: 'center' }}>
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: 12,
          backgroundColor: active ? color : '#E5E7EB',
          margin: '0 auto 8px',
          color: '#FFFFFF',
          fontSize: 13,
          lineHeight: '24px',
          fontWeight: 700,
        }}
      >
        {active ? '✓' : ' '}
      </div>
      <Text style={{ margin: 0, fontSize: 12, color: active ? '#111827' : '#9CA3AF', fontWeight: active ? 600 : 400 }}>
        {label}
      </Text>
    </Column>
  );
}

export const ShippingTrackerBlock: EmailBlockEntry<ShippingTrackerProps> = {
  componentId: 'shipping_tracker',
  label: 'Shipping tracker',
  category: 'Ecommerce',
  fields: {
    current_stage: {
      type: 'select',
      label: 'Current stage',
      options: [
        { label: 'Ordered', value: '1' },
        { label: 'Packed', value: '2' },
        { label: 'Shipped', value: '3' },
        { label: 'Delivered', value: '4' },
      ],
    },
    stage_1_label: { type: 'text', label: 'Stage 1 label' },
    stage_2_label: { type: 'text', label: 'Stage 2 label' },
    stage_3_label: { type: 'text', label: 'Stage 3 label' },
    stage_4_label: { type: 'text', label: 'Stage 4 label' },
    accent_color: { type: 'text', label: 'Accent colour' },
    eta_text: { type: 'text', label: 'ETA copy' },
  },
  defaultProps: {
    current_stage: '3',
    stage_1_label: 'Ordered',
    stage_2_label: 'Packed',
    stage_3_label: 'Shipped',
    stage_4_label: 'Delivered',
    accent_color: '#10B981',
    eta_text: 'Estimated delivery: Wednesday, May 14',
  },
  Component: (p) => {
    const idx = Number(p.current_stage);
    return (
      <Section style={{ padding: '32px 16px' }}>
        <Row>
          <Step label={p.stage_1_label} active={idx >= 1} color={p.accent_color} />
          <Step label={p.stage_2_label} active={idx >= 2} color={p.accent_color} />
          <Step label={p.stage_3_label} active={idx >= 3} color={p.accent_color} />
          <Step label={p.stage_4_label} active={idx >= 4} color={p.accent_color} />
        </Row>
        {p.eta_text ? (
          <Text style={{ margin: '20px 0 0', fontSize: 13, color: '#6B7280', textAlign: 'center' }}>
            {p.eta_text}
          </Text>
        ) : null}
      </Section>
    );
  },
};
