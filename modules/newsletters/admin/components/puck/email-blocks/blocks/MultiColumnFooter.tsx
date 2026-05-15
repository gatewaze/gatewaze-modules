/**
 * Multi-column footer with three labeled link groups. Variant of the
 * basic Footer for product newsletters that want a sitemap-style block
 * near the bottom. Each column has a heading + three links.
 */

import { Column, Link, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface MultiColumnFooterProps extends Record<string, unknown> {
  col_1_heading: string;
  col_1_link_1_label: string;
  col_1_link_1_url: string;
  col_1_link_2_label: string;
  col_1_link_2_url: string;
  col_1_link_3_label: string;
  col_1_link_3_url: string;
  col_2_heading: string;
  col_2_link_1_label: string;
  col_2_link_1_url: string;
  col_2_link_2_label: string;
  col_2_link_2_url: string;
  col_2_link_3_label: string;
  col_2_link_3_url: string;
  col_3_heading: string;
  col_3_link_1_label: string;
  col_3_link_1_url: string;
  col_3_link_2_label: string;
  col_3_link_2_url: string;
  col_3_link_3_label: string;
  col_3_link_3_url: string;
  copyright: string;
}

function FooterColumn({ heading, links }: { heading: string; links: Array<{ label: string; url: string }> }) {
  const visible = links.filter((l) => l.label);
  return (
    <Column style={{ verticalAlign: 'top', padding: '0 8px' }}>
      <Text style={{ margin: '0 0 8px', fontWeight: 600, fontSize: 13, color: '#111827' }}>{heading}</Text>
      {visible.map((l, i) => (
        <Text key={`${l.label}-${i}`} style={{ margin: '0 0 6px', fontSize: 13 }}>
          <Link href={l.url || '#'} style={{ color: '#6B7280', textDecoration: 'none' }}>
            {l.label}
          </Link>
        </Text>
      ))}
    </Column>
  );
}

export const MultiColumnFooterBlock: EmailBlockEntry<MultiColumnFooterProps> = {
  componentId: 'multi_column_footer',
  label: 'Footer with link columns',
  category: 'Navigation',
  fields: {
    col_1_heading: { type: 'text', label: 'Column 1 — heading' },
    col_1_link_1_label: { type: 'text', label: 'Column 1 — link 1 label' },
    col_1_link_1_url: { type: 'text', label: 'Column 1 — link 1 URL' },
    col_1_link_2_label: { type: 'text', label: 'Column 1 — link 2 label' },
    col_1_link_2_url: { type: 'text', label: 'Column 1 — link 2 URL' },
    col_1_link_3_label: { type: 'text', label: 'Column 1 — link 3 label' },
    col_1_link_3_url: { type: 'text', label: 'Column 1 — link 3 URL' },
    col_2_heading: { type: 'text', label: 'Column 2 — heading' },
    col_2_link_1_label: { type: 'text', label: 'Column 2 — link 1 label' },
    col_2_link_1_url: { type: 'text', label: 'Column 2 — link 1 URL' },
    col_2_link_2_label: { type: 'text', label: 'Column 2 — link 2 label' },
    col_2_link_2_url: { type: 'text', label: 'Column 2 — link 2 URL' },
    col_2_link_3_label: { type: 'text', label: 'Column 2 — link 3 label' },
    col_2_link_3_url: { type: 'text', label: 'Column 2 — link 3 URL' },
    col_3_heading: { type: 'text', label: 'Column 3 — heading' },
    col_3_link_1_label: { type: 'text', label: 'Column 3 — link 1 label' },
    col_3_link_1_url: { type: 'text', label: 'Column 3 — link 1 URL' },
    col_3_link_2_label: { type: 'text', label: 'Column 3 — link 2 label' },
    col_3_link_2_url: { type: 'text', label: 'Column 3 — link 2 URL' },
    col_3_link_3_label: { type: 'text', label: 'Column 3 — link 3 label' },
    col_3_link_3_url: { type: 'text', label: 'Column 3 — link 3 URL' },
    copyright: { type: 'text', label: 'Copyright line' },
  },
  defaultProps: {
    col_1_heading: 'Product',
    col_1_link_1_label: 'Features',
    col_1_link_1_url: '#',
    col_1_link_2_label: 'Pricing',
    col_1_link_2_url: '#',
    col_1_link_3_label: 'Changelog',
    col_1_link_3_url: '#',
    col_2_heading: 'Company',
    col_2_link_1_label: 'About',
    col_2_link_1_url: '#',
    col_2_link_2_label: 'Careers',
    col_2_link_2_url: '#',
    col_2_link_3_label: 'Contact',
    col_2_link_3_url: '#',
    col_3_heading: 'Resources',
    col_3_link_1_label: 'Blog',
    col_3_link_1_url: '#',
    col_3_link_2_label: 'Docs',
    col_3_link_2_url: '#',
    col_3_link_3_label: 'Support',
    col_3_link_3_url: '#',
    copyright: '© 2026 Your Company. All rights reserved.',
  },
  Component: (p) => (
    <Section style={{ padding: '40px 24px', borderTop: '1px solid #E5E7EB', backgroundColor: '#F9FAFB' }}>
      <Row>
        <FooterColumn
          heading={p.col_1_heading}
          links={[
            { label: p.col_1_link_1_label, url: p.col_1_link_1_url },
            { label: p.col_1_link_2_label, url: p.col_1_link_2_url },
            { label: p.col_1_link_3_label, url: p.col_1_link_3_url },
          ]}
        />
        <FooterColumn
          heading={p.col_2_heading}
          links={[
            { label: p.col_2_link_1_label, url: p.col_2_link_1_url },
            { label: p.col_2_link_2_label, url: p.col_2_link_2_url },
            { label: p.col_2_link_3_label, url: p.col_2_link_3_url },
          ]}
        />
        <FooterColumn
          heading={p.col_3_heading}
          links={[
            { label: p.col_3_link_1_label, url: p.col_3_link_1_url },
            { label: p.col_3_link_2_label, url: p.col_3_link_2_url },
            { label: p.col_3_link_3_label, url: p.col_3_link_3_url },
          ]}
        />
      </Row>
      <Text style={{ margin: '24px 0 0', fontSize: 12, color: '#9CA3AF', textAlign: 'center' }}>
        {p.copyright}
      </Text>
    </Section>
  ),
};
