/**
 * Cart summary — line items + subtotal/tax/total. Suited for "you
 * left items in your cart" or order-confirmation emails.
 */

import { Column, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface CartSummaryProps extends Record<string, unknown> {
  heading: string;
  item_1_name: string;
  item_1_qty: string;
  item_1_price: string;
  item_2_name: string;
  item_2_qty: string;
  item_2_price: string;
  item_3_name: string;
  item_3_qty: string;
  item_3_price: string;
  subtotal: string;
  shipping: string;
  total: string;
}

function Line({ name, qty, price }: { name: string; qty: string; price: string }) {
  if (!name) return null;
  return (
    <Row style={{ padding: '8px 0' }}>
      <Column style={{ verticalAlign: 'middle' }}>
        <Text style={{ margin: 0, fontSize: 14, color: '#111827' }}>{name}</Text>
        <Text style={{ margin: 0, fontSize: 12, color: '#6B7280' }}>Qty: {qty}</Text>
      </Column>
      <Column style={{ width: 80, verticalAlign: 'middle', textAlign: 'right' }}>
        <Text style={{ margin: 0, fontSize: 14, color: '#111827' }}>{price}</Text>
      </Column>
    </Row>
  );
}

export const CartSummaryBlock: EmailBlockEntry<CartSummaryProps> = {
  componentId: 'cart_summary',
  label: 'Cart summary',
  category: 'Ecommerce',
  fields: {
    heading: { type: 'text', label: 'Heading' },
    item_1_name: { type: 'text', label: 'Item 1 — name' },
    item_1_qty: { type: 'text', label: 'Item 1 — qty' },
    item_1_price: { type: 'text', label: 'Item 1 — price' },
    item_2_name: { type: 'text', label: 'Item 2 — name' },
    item_2_qty: { type: 'text', label: 'Item 2 — qty' },
    item_2_price: { type: 'text', label: 'Item 2 — price' },
    item_3_name: { type: 'text', label: 'Item 3 — name' },
    item_3_qty: { type: 'text', label: 'Item 3 — qty' },
    item_3_price: { type: 'text', label: 'Item 3 — price' },
    subtotal: { type: 'text', label: 'Subtotal' },
    shipping: { type: 'text', label: 'Shipping' },
    total: { type: 'text', label: 'Total' },
  },
  defaultProps: {
    heading: 'Your order',
    item_1_name: 'Sample Product A',
    item_1_qty: '1',
    item_1_price: '$29.00',
    item_2_name: 'Sample Product B',
    item_2_qty: '2',
    item_2_price: '$58.00',
    item_3_name: '',
    item_3_qty: '',
    item_3_price: '',
    subtotal: '$87.00',
    shipping: '$5.00',
    total: '$92.00',
  },
  Component: (p) => (
    <Section style={{ padding: '24px', backgroundColor: '#F9FAFB', borderRadius: 8 }}>
      <Text style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600, color: '#111827' }}>{p.heading}</Text>
      <Line name={p.item_1_name} qty={p.item_1_qty} price={p.item_1_price} />
      <Line name={p.item_2_name} qty={p.item_2_qty} price={p.item_2_price} />
      <Line name={p.item_3_name} qty={p.item_3_qty} price={p.item_3_price} />
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #E5E7EB' }}>
        <Row style={{ padding: '4px 0' }}>
          <Column><Text style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>Subtotal</Text></Column>
          <Column style={{ textAlign: 'right' }}><Text style={{ margin: 0, fontSize: 13, color: '#111827' }}>{p.subtotal}</Text></Column>
        </Row>
        <Row style={{ padding: '4px 0' }}>
          <Column><Text style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>Shipping</Text></Column>
          <Column style={{ textAlign: 'right' }}><Text style={{ margin: 0, fontSize: 13, color: '#111827' }}>{p.shipping}</Text></Column>
        </Row>
        <Row style={{ padding: '8px 0 0' }}>
          <Column><Text style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#111827' }}>Total</Text></Column>
          <Column style={{ textAlign: 'right' }}><Text style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#111827' }}>{p.total}</Text></Column>
        </Row>
      </div>
    </Section>
  ),
};
