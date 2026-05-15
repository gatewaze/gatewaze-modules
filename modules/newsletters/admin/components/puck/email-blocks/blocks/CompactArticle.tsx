/**
 * Compact article preview — single-line title + short excerpt + reading
 * time/badge. Useful in densely-packed newsletter summaries.
 */

import { Link, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface CompactArticleProps extends Record<string, unknown> {
  badge: string;
  title: string;
  excerpt: string;
  url: string;
}

export const CompactArticleBlock: EmailBlockEntry<CompactArticleProps> = {
  componentId: 'compact_article',
  label: 'Compact article',
  category: 'Articles',
  fields: {
    badge: { type: 'text', label: 'Badge / reading time' },
    title: { type: 'text', label: 'Title', contentEditable: true },
    excerpt: { type: 'text', label: 'Short excerpt', contentEditable: true },
    url: { type: 'text', label: 'URL' },
  },
  defaultProps: {
    badge: '5 min read',
    title: 'A concise article headline',
    excerpt: 'Single-line summary for skimmable layouts.',
    url: '#',
  },
  Component: ({ badge, title, excerpt, url }) => (
    <Section style={{ padding: '12px 0' }}>
      {badge ? (
        <Text style={{ margin: '0 0 4px', fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: 1 }}>
          {badge}
        </Text>
      ) : null}
      <Text style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600 }}>
        <Link href={url} style={{ color: '#111827', textDecoration: 'none' }}>{title}</Link>
      </Text>
      <Text style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>{excerpt}</Text>
    </Section>
  ),
};
