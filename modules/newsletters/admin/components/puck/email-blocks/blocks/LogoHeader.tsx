/**
 * Logo header composite — small logo on the left, brand label on the
 * right. Mirrors the top-of-edition strip in Barebone `welcome.tsx`
 * (logo image + "{brand}" text aligned right).
 *
 * Distinct from the existing Header composite, which is title-led.
 * Pair these: LogoHeader at the very top, then Header for the
 * edition's headline.
 */

import { Column, Img, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface LogoHeaderProps extends Record<string, unknown> {
  logo_url: string;
  brand_label: string;
  logo_width: string;
}

export const LogoHeaderBlock: EmailBlockEntry<LogoHeaderProps> = {
  componentId: 'logo_header',
  label: 'Logo header',
  category: 'Navigation',
  fields: {
    logo_url: { type: 'custom', label: 'Logo', render: NewsletterImageFieldAdapter as never },
    brand_label: { type: 'text', label: 'Brand label (right side)' },
    logo_width: { type: 'text', label: 'Logo width (px)' },
  },
  defaultProps: {
    logo_url: '',
    brand_label: '',
    logo_width: '24',
  },
  Component: ({ logo_url, brand_label, logo_width }) => {
    const w = parseInt(logo_width, 10);
    const width = Number.isFinite(w) && w > 0 ? w : 24;
    return (
      <Section style={{ padding: '16px 24px' }}>
        <Row>
          <Column style={{ width: '50%', verticalAlign: 'middle' }}>
            {logo_url ? <Img src={logo_url} alt="" width={width} style={{ display: 'block' }} /> : null}
          </Column>
          <Column style={{ width: '50%', verticalAlign: 'middle', textAlign: 'right' }}>
            {brand_label ? (
              <Text style={{ margin: 0, fontSize: 13, color: '#7B7D81', textAlign: 'right' }}>{brand_label}</Text>
            ) : null}
          </Column>
        </Row>
      </Section>
    );
  },
};
