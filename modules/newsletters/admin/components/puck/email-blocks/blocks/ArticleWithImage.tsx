/**
 * Article with image — full-width hero image with title + body below.
 * Magazine-style layout, between FeaturedArticle (big CTA) and
 * ArticleCard (compact list).
 */

import { Img, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface ArticleWithImageProps extends Record<string, unknown> {
  image_url: string;
  alt: string;
  title: string;
  body: string;
}

export const ArticleWithImageBlock: EmailBlockEntry<ArticleWithImageProps> = {
  componentId: 'article_with_image',
  label: 'Article with image',
  category: 'Articles',
  fields: {
    image_url: { type: 'custom', label: 'Image', render: NewsletterImageFieldAdapter as never },
    alt: { type: 'text', label: 'Alt text' },
    title: { type: 'text', label: 'Title', contentEditable: true },
    body: { type: 'textarea', label: 'Body', contentEditable: true },
  },
  defaultProps: {
    image_url: '',
    alt: '',
    title: 'A magazine-style article headline',
    body: 'The body of the article runs below the hero image. Multiple paragraphs of context fit naturally here.',
  },
  Component: ({ image_url, alt, title, body }) => (
    <Section style={{ padding: '24px 0' }}>
      {image_url ? (
        <Img src={image_url} alt={alt} width={600} style={{ display: 'block', width: '100%', maxWidth: '100%', marginBottom: 20 }} />
      ) : null}
      <Text style={{ margin: '0 0 12px', fontSize: 24, fontWeight: 700, color: '#111827' }}>{title}</Text>
      <Text style={{ margin: 0, fontSize: 15, color: '#374151', lineHeight: '1.6' }}>{body}</Text>
    </Section>
  ),
};
