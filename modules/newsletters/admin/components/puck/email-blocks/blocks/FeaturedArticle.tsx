/**
 * Featured article — large hero image + bold title + excerpt + CTA.
 * Centerpiece for editorial newsletters, distinct from ArticleCard
 * which is meant for inline listing.
 */

import { Img, Link, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface FeaturedArticleProps extends Record<string, unknown> {
  image_url: string;
  category: string;
  title: string;
  excerpt: string;
  cta_label: string;
  cta_url: string;
}

export const FeaturedArticleBlock: EmailBlockEntry<FeaturedArticleProps> = {
  componentId: 'featured_article',
  label: 'Featured article',
  category: 'Articles',
  fields: {
    image_url: { type: 'custom', label: 'Hero image', render: NewsletterImageFieldAdapter as never },
    category: { type: 'text', label: 'Category tag', contentEditable: true },
    title: { type: 'textarea', label: 'Title', contentEditable: true },
    excerpt: { type: 'textarea', label: 'Excerpt', contentEditable: true },
    cta_label: { type: 'text', label: 'CTA label', contentEditable: true },
    cta_url: { type: 'text', label: 'CTA URL' },
  },
  defaultProps: {
    image_url: '',
    category: 'FEATURED',
    title: 'A bold, attention-grabbing feature headline',
    excerpt: 'A longer excerpt that gives readers a real preview of what they\'ll find on the other side of the click.',
    cta_label: 'Read the full story',
    cta_url: '#',
  },
  Component: ({ image_url, category, title, excerpt, cta_label, cta_url }) => (
    <Section style={{ padding: '32px 0' }}>
      {image_url ? (
        <Img src={image_url} alt="" width={600} style={{ display: 'block', width: '100%', maxWidth: '100%', borderRadius: 8, marginBottom: 20 }} />
      ) : null}
      {category ? (
        <Text style={{ margin: '0 0 8px', fontSize: 11, fontWeight: 700, color: '#2563EB', letterSpacing: 1.5 }}>
          {category}
        </Text>
      ) : null}
      <Text style={{ margin: '0 0 12px', fontSize: 28, fontWeight: 700, color: '#111827', lineHeight: '1.2' }}>
        {title}
      </Text>
      <Text style={{ margin: '0 0 16px', fontSize: 16, color: '#4B5563', lineHeight: '1.5' }}>
        {excerpt}
      </Text>
      {cta_label && cta_url ? (
        <Link href={cta_url} style={{ color: '#2563EB', fontSize: 15, fontWeight: 600, textDecoration: 'none' }}>
          {cta_label} →
        </Link>
      ) : null}
    </Section>
  ),
};
