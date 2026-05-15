/**
 * Header with horizontal nav links — variant of the basic Header.
 * Common at the top of marketing newsletters: logo on the left, three
 * to five top-level links on the right. Uses react-email Row/Column so
 * it survives Outlook's table-only layout requirements.
 */

import { Img, Link, Row, Column, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface HeaderWithNavProps extends Record<string, unknown> {
  logo_url: string;
  logo_width: string;
  link_1_label: string;
  link_1_url: string;
  link_2_label: string;
  link_2_url: string;
  link_3_label: string;
  link_3_url: string;
  link_4_label: string;
  link_4_url: string;
}

export const HeaderWithNavBlock: EmailBlockEntry<HeaderWithNavProps> = {
  componentId: 'header_with_nav',
  label: 'Header with nav',
  category: 'Navigation',
  fields: {
    logo_url: { type: 'custom', label: 'Logo', render: NewsletterImageFieldAdapter as never },
    logo_width: { type: 'text', label: 'Logo width (px)' },
    link_1_label: { type: 'text', label: 'Link 1 — label' },
    link_1_url: { type: 'text', label: 'Link 1 — URL' },
    link_2_label: { type: 'text', label: 'Link 2 — label' },
    link_2_url: { type: 'text', label: 'Link 2 — URL' },
    link_3_label: { type: 'text', label: 'Link 3 — label' },
    link_3_url: { type: 'text', label: 'Link 3 — URL' },
    link_4_label: { type: 'text', label: 'Link 4 — label (optional)' },
    link_4_url: { type: 'text', label: 'Link 4 — URL (optional)' },
  },
  defaultProps: {
    logo_url: '',
    logo_width: '120',
    link_1_label: 'Product',
    link_1_url: '#',
    link_2_label: 'Pricing',
    link_2_url: '#',
    link_3_label: 'Blog',
    link_3_url: '#',
    link_4_label: '',
    link_4_url: '',
  },
  Component: ({
    logo_url,
    logo_width,
    link_1_label,
    link_1_url,
    link_2_label,
    link_2_url,
    link_3_label,
    link_3_url,
    link_4_label,
    link_4_url,
  }) => {
    const links = [
      { label: link_1_label, url: link_1_url },
      { label: link_2_label, url: link_2_url },
      { label: link_3_label, url: link_3_url },
      { label: link_4_label, url: link_4_url },
    ].filter((l) => l.label && l.url);
    return (
      <Section style={{ padding: '24px 0', borderBottom: '1px solid #E5E7EB' }}>
        <Row>
          <Column style={{ verticalAlign: 'middle' }}>
            {logo_url ? <Img src={logo_url} alt="" width={Number(logo_width) || 120} /> : null}
          </Column>
          <Column style={{ verticalAlign: 'middle', textAlign: 'right', fontSize: 14 }}>
            {links.map((l, i) => (
              <Link
                key={`${l.url}-${i}`}
                href={l.url}
                style={{ color: '#374151', textDecoration: 'none', marginLeft: i === 0 ? 0 : 20 }}
              >
                {l.label}
              </Link>
            ))}
          </Column>
        </Row>
      </Section>
    );
  },
};
