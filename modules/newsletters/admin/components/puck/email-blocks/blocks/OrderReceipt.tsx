/**
 * Order receipt — order number + date + line items + delivery details.
 * Used in transactional purchase-confirmation emails.
 */

import { Column, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface OrderReceiptProps extends Record<string, unknown> {
  order_number: string;
  order_date: string;
  customer_name: string;
  shipping_address: string;
  payment_method: string;
  items_summary: string;
  total: string;
}

export const OrderReceiptBlock: EmailBlockEntry<OrderReceiptProps> = {
  componentId: 'order_receipt',
  label: 'Order receipt',
  category: 'Ecommerce',
  fields: {
    order_number: { type: 'text', label: 'Order number' },
    order_date: { type: 'text', label: 'Order date' },
    customer_name: { type: 'text', label: 'Customer name' },
    shipping_address: { type: 'textarea', label: 'Shipping address' },
    payment_method: { type: 'text', label: 'Payment method' },
    items_summary: { type: 'textarea', label: 'Items summary' },
    total: { type: 'text', label: 'Total' },
  },
  defaultProps: {
    order_number: '#1024',
    order_date: 'May 11, 2026',
    customer_name: 'Jane Doe',
    shipping_address: '123 Example St\nLondon, EC1A 1BB',
    payment_method: 'Visa ending 4242',
    items_summary: '1× Sample Product A — $29.00\n2× Sample Product B — $58.00',
    total: '$92.00',
  },
  Component: (p) => (
    <Section style={{ padding: '24px', backgroundColor: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: 8 }}>
      <Row>
        <Column>
          <Text style={{ margin: '0 0 4px', fontSize: 12, color: '#6B7280' }}>Order</Text>
          <Text style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>{p.order_number}</Text>
        </Column>
        <Column style={{ textAlign: 'right' }}>
          <Text style={{ margin: '0 0 4px', fontSize: 12, color: '#6B7280' }}>Placed on</Text>
          <Text style={{ margin: 0, fontSize: 13, color: '#111827' }}>{p.order_date}</Text>
        </Column>
      </Row>
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #E5E7EB' }}>
        <Text style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: '#111827' }}>Ships to</Text>
        <Text style={{ margin: '0 0 4px', fontSize: 13, color: '#374151', whiteSpace: 'pre-line' }}>
          {p.customer_name}{'\n'}{p.shipping_address}
        </Text>
        <Text style={{ margin: '8px 0 0', fontSize: 12, color: '#6B7280' }}>Paid with {p.payment_method}</Text>
      </div>
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #E5E7EB' }}>
        <Text style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: '#111827' }}>Items</Text>
        <Text style={{ margin: 0, fontSize: 13, color: '#374151', whiteSpace: 'pre-line' }}>{p.items_summary}</Text>
      </div>
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #E5E7EB' }}>
        <Row>
          <Column><Text style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#111827' }}>Total</Text></Column>
          <Column style={{ textAlign: 'right' }}><Text style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#111827' }}>{p.total}</Text></Column>
        </Row>
      </div>
    </Section>
  ),
};
