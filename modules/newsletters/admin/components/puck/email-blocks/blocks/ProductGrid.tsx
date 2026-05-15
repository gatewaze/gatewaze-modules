/**
 * Three-product grid — used in promotional emails to surface multiple
 * SKUs at once.
 */

import { Column, Img, Link, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface ProductGridProps extends Record<string, unknown> {
  p1_image: string;
  p1_name: string;
  p1_price: string;
  p1_url: string;
  p2_image: string;
  p2_name: string;
  p2_price: string;
  p2_url: string;
  p3_image: string;
  p3_name: string;
  p3_price: string;
  p3_url: string;
}

function Cell({ image, name, price, url }: { image: string; name: string; price: string; url: string }) {
  return (
    <Column style={{ width: 'calc(100% / 3)', verticalAlign: 'top', padding: '0 8px' }}>
      {image ? <Img src={image} alt="" width={180} style={{ display: 'block', width: '100%', maxWidth: '100%', borderRadius: 6, marginBottom: 8 }} /> : null}
      <Text style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: '#111827' }}>
        <Link href={url} style={{ color: '#111827', textDecoration: 'none' }}>{name}</Link>
      </Text>
      <Text style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>{price}</Text>
    </Column>
  );
}

export const ProductGridBlock: EmailBlockEntry<ProductGridProps> = {
  componentId: 'product_grid',
  label: 'Product grid (3-up)',
  category: 'Ecommerce',
  fields: {
    p1_image: { type: 'custom', label: 'Product 1 — image', render: NewsletterImageFieldAdapter as never },
    p1_name: { type: 'text', label: 'Product 1 — name' },
    p1_price: { type: 'text', label: 'Product 1 — price' },
    p1_url: { type: 'text', label: 'Product 1 — URL' },
    p2_image: { type: 'custom', label: 'Product 2 — image', render: NewsletterImageFieldAdapter as never },
    p2_name: { type: 'text', label: 'Product 2 — name' },
    p2_price: { type: 'text', label: 'Product 2 — price' },
    p2_url: { type: 'text', label: 'Product 2 — URL' },
    p3_image: { type: 'custom', label: 'Product 3 — image', render: NewsletterImageFieldAdapter as never },
    p3_name: { type: 'text', label: 'Product 3 — name' },
    p3_price: { type: 'text', label: 'Product 3 — price' },
    p3_url: { type: 'text', label: 'Product 3 — URL' },
  },
  defaultProps: {
    p1_image: '', p1_name: 'Product One', p1_price: '$29', p1_url: '#',
    p2_image: '', p2_name: 'Product Two', p2_price: '$39', p2_url: '#',
    p3_image: '', p3_name: 'Product Three', p3_price: '$49', p3_url: '#',
  },
  Component: (p) => (
    <Section style={{ padding: '24px 0' }}>
      <Row>
        <Cell image={p.p1_image} name={p.p1_name} price={p.p1_price} url={p.p1_url} />
        <Cell image={p.p2_image} name={p.p2_name} price={p.p2_price} url={p.p2_url} />
        <Cell image={p.p3_image} name={p.p3_name} price={p.p3_price} url={p.p3_url} />
      </Row>
    </Section>
  ),
};
