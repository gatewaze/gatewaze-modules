/**
 * Product card — image + name + price + CTA. Standard ecommerce promo
 * unit.
 */

import { Button, Img, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface ProductCardProps extends Record<string, unknown> {
  image_url: string;
  name: string;
  price: string;
  cta_label: string;
  cta_url: string;
}

export const ProductCardBlock: EmailBlockEntry<ProductCardProps> = {
  componentId: 'product_card',
  label: 'Product card',
  category: 'Ecommerce',
  fields: {
    image_url: { type: 'custom', label: 'Product image', render: NewsletterImageFieldAdapter as never },
    name: { type: 'text', label: 'Product name' },
    price: { type: 'text', label: 'Price' },
    cta_label: { type: 'text', label: 'CTA label' },
    cta_url: { type: 'text', label: 'CTA URL' },
  },
  defaultProps: {
    image_url: '',
    name: 'Product name',
    price: '$49.00',
    cta_label: 'Shop now',
    cta_url: '#',
  },
  Component: ({ image_url, name, price, cta_label, cta_url }) => (
    <Section style={{ padding: '20px', backgroundColor: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: 8, textAlign: 'center' }}>
      {image_url ? (
        <Img src={image_url} alt="" width={280} style={{ display: 'block', margin: '0 auto 16px', maxWidth: '100%', borderRadius: 6 }} />
      ) : null}
      <Text style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: '#111827' }}>{name}</Text>
      <Text style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700, color: '#111827' }}>{price}</Text>
      {cta_label && cta_url ? (
        <Button
          href={cta_url}
          style={{ display: 'inline-block', backgroundColor: '#111827', color: '#FFFFFF', padding: '10px 20px', borderRadius: 6, fontSize: 14, fontWeight: 600 }}
        >
          {cta_label}
        </Button>
      ) : null}
    </Section>
  ),
};
