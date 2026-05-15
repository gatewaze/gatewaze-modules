/**
 * Article preview card — image (left/top) + headline + excerpt + link.
 * Standard newsletter pattern for surfacing blog/article links.
 */

import { Column, Img, Link, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface ArticleCardProps extends Record<string, unknown> {
  image_url: string;
  title: string;
  excerpt: string;
  cta_label: string;
  cta_url: string;
  layout: 'horizontal' | 'vertical';
}

export const ArticleCardBlock: EmailBlockEntry<ArticleCardProps> = {
  componentId: 'article_card',
  label: 'Article card',
  category: 'Articles',
  fields: {
    image_url: { type: 'custom', label: 'Image', render: NewsletterImageFieldAdapter as never },
    title: { type: 'text', label: 'Title', contentEditable: true },
    excerpt: { type: 'textarea', label: 'Excerpt', contentEditable: true },
    cta_label: { type: 'text', label: 'CTA label', contentEditable: true },
    cta_url: { type: 'text', label: 'CTA URL' },
    layout: {
      type: 'select',
      label: 'Layout',
      options: [
        { label: 'Horizontal (image left)', value: 'horizontal' },
        { label: 'Vertical (image top)', value: 'vertical' },
      ],
    },
  },
  defaultProps: {
    image_url: '',
    title: 'How we doubled our newsletter open rate',
    excerpt: 'A short summary of the article goes here — one or two sentences pulled from the lead.',
    cta_label: 'Read article',
    cta_url: '#',
    layout: 'horizontal',
  },
  Component: ({ image_url, title, excerpt, cta_label, cta_url, layout }) => {
    const titleEl = (
      <Text style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 700, color: '#111827', lineHeight: '1.3' }}>
        {title}
      </Text>
    );
    const excerptEl = (
      <Text style={{ margin: '0 0 12px', fontSize: 14, color: '#4B5563', lineHeight: '1.5' }}>{excerpt}</Text>
    );
    const ctaEl = cta_label && cta_url ? (
      <Link href={cta_url} style={{ color: '#2563EB', fontSize: 14, fontWeight: 600, textDecoration: 'none' }}>
        {cta_label} →
      </Link>
    ) : null;
    const imgEl = image_url ? (
      <Img src={image_url} alt="" width={layout === 'horizontal' ? 200 : 600} style={{ display: 'block', maxWidth: '100%', borderRadius: 6 }} />
    ) : null;

    if (layout === 'vertical') {
      return (
        <Section style={{ padding: '20px 0' }}>
          {imgEl ? <Section style={{ marginBottom: 16 }}>{imgEl}</Section> : null}
          {titleEl}
          {excerptEl}
          {ctaEl}
        </Section>
      );
    }
    return (
      <Section style={{ padding: '20px 0' }}>
        <Row>
          {imgEl ? (
            <Column style={{ width: 200, verticalAlign: 'top', paddingRight: 16 }}>{imgEl}</Column>
          ) : null}
          <Column style={{ verticalAlign: 'top' }}>
            {titleEl}
            {excerptEl}
            {ctaEl}
          </Column>
        </Row>
      </Section>
    );
  },
};
