/**
 * Article list — three compact rows (title + excerpt). Compact
 * companion to ArticleCard, suited for "in case you missed it"
 * sections at the bottom of newsletters.
 */

import { Link, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface ArticleListProps extends Record<string, unknown> {
  heading: string;
  item_1_title: string;
  item_1_excerpt: string;
  item_1_url: string;
  item_2_title: string;
  item_2_excerpt: string;
  item_2_url: string;
  item_3_title: string;
  item_3_excerpt: string;
  item_3_url: string;
}

function Item({ title, excerpt, url }: { title: string; excerpt: string; url: string }) {
  if (!title) return null;
  return (
    <div style={{ padding: '16px 0', borderBottom: '1px solid #E5E7EB' }}>
      <Text style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600 }}>
        <Link href={url || '#'} style={{ color: '#111827', textDecoration: 'none' }}>
          {title}
        </Link>
      </Text>
      <Text style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>{excerpt}</Text>
    </div>
  );
}

export const ArticleListBlock: EmailBlockEntry<ArticleListProps> = {
  componentId: 'article_list',
  label: 'Article list',
  category: 'Articles',
  fields: {
    heading: { type: 'text', label: 'Section heading' },
    item_1_title: { type: 'text', label: 'Article 1 — title' },
    item_1_excerpt: { type: 'textarea', label: 'Article 1 — excerpt' },
    item_1_url: { type: 'text', label: 'Article 1 — URL' },
    item_2_title: { type: 'text', label: 'Article 2 — title' },
    item_2_excerpt: { type: 'textarea', label: 'Article 2 — excerpt' },
    item_2_url: { type: 'text', label: 'Article 2 — URL' },
    item_3_title: { type: 'text', label: 'Article 3 — title' },
    item_3_excerpt: { type: 'textarea', label: 'Article 3 — excerpt' },
    item_3_url: { type: 'text', label: 'Article 3 — URL' },
  },
  defaultProps: {
    heading: 'Recently published',
    item_1_title: 'First article title',
    item_1_excerpt: 'A short summary of the first piece.',
    item_1_url: '#',
    item_2_title: 'Second article title',
    item_2_excerpt: 'A short summary of the second piece.',
    item_2_url: '#',
    item_3_title: 'Third article title',
    item_3_excerpt: 'A short summary of the third piece.',
    item_3_url: '#',
  },
  Component: (p) => (
    <Section style={{ padding: '24px 0' }}>
      {p.heading ? (
        <Text style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: 1 }}>
          {p.heading}
        </Text>
      ) : null}
      <Item title={p.item_1_title} excerpt={p.item_1_excerpt} url={p.item_1_url} />
      <Item title={p.item_2_title} excerpt={p.item_2_excerpt} url={p.item_2_url} />
      <Item title={p.item_3_title} excerpt={p.item_3_excerpt} url={p.item_3_url} />
    </Section>
  ),
};
