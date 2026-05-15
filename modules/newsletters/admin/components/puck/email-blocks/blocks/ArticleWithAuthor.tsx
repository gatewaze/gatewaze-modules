/**
 * Article preview with author byline — avatar + author + date + title
 * + excerpt + link. Blog-roll style for editorial newsletters.
 */

import { Column, Img, Link, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface ArticleWithAuthorProps extends Record<string, unknown> {
  avatar_url: string;
  author_name: string;
  publish_date: string;
  title: string;
  excerpt: string;
  url: string;
}

export const ArticleWithAuthorBlock: EmailBlockEntry<ArticleWithAuthorProps> = {
  componentId: 'article_with_author',
  label: 'Article with author byline',
  category: 'Articles',
  fields: {
    avatar_url: { type: 'custom', label: 'Author avatar', render: NewsletterImageFieldAdapter as never },
    author_name: { type: 'text', label: 'Author name' },
    publish_date: { type: 'text', label: 'Publish date' },
    title: { type: 'text', label: 'Title', contentEditable: true },
    excerpt: { type: 'textarea', label: 'Excerpt', contentEditable: true },
    url: { type: 'text', label: 'Article URL' },
  },
  defaultProps: {
    avatar_url: '',
    author_name: 'Jane Doe',
    publish_date: 'May 11, 2026',
    title: 'A thoughtful headline that draws the reader in',
    excerpt: 'A short summary highlighting the key idea of the article.',
    url: '#',
  },
  Component: ({ avatar_url, author_name, publish_date, title, excerpt, url }) => (
    <Section style={{ padding: '24px 0', borderBottom: '1px solid #E5E7EB' }}>
      <Row style={{ marginBottom: 12 }}>
        {avatar_url ? (
          <Column style={{ width: 40, verticalAlign: 'middle' }}>
            <Img src={avatar_url} alt="" width={32} style={{ borderRadius: 16 }} />
          </Column>
        ) : null}
        <Column style={{ verticalAlign: 'middle' }}>
          <Text style={{ margin: 0, fontSize: 13, color: '#111827', fontWeight: 600 }}>{author_name}</Text>
          <Text style={{ margin: 0, fontSize: 12, color: '#6B7280' }}>{publish_date}</Text>
        </Column>
      </Row>
      <Text style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 700, color: '#111827' }}>
        <Link href={url} style={{ color: '#111827', textDecoration: 'none' }}>{title}</Link>
      </Text>
      <Text style={{ margin: 0, fontSize: 14, color: '#4B5563', lineHeight: '1.5' }}>{excerpt}</Text>
    </Section>
  ),
};
