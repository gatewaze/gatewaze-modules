/**
 * Markdown rendered inside a blockquote-style frame — for excerpts,
 * featured callouts, or release-note highlights.
 */

import { Markdown, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface MarkdownBlockquoteProps extends Record<string, unknown> {
  source: string;
  accent_color: string;
  background: string;
}

export const MarkdownBlockquoteBlock: EmailBlockEntry<MarkdownBlockquoteProps> = {
  componentId: 'markdown_blockquote',
  label: 'Markdown (blockquote)',
  category: 'Content',
  fields: {
    // contentEditable disabled — marked() requires a raw string; see MarkdownContent.tsx.
    source: { type: 'textarea', label: 'Markdown source', contentEditable: false },
    accent_color: { type: 'text', label: 'Left rule colour' },
    background: { type: 'text', label: 'Background colour' },
  },
  defaultProps: {
    source: '**Heads up:** the new pricing takes effect on June 1.',
    accent_color: '#F59E0B',
    background: '#FFFBEB',
  },
  Component: ({ source, accent_color, background }) => (
    <Section style={{ padding: '16px 0' }}>
      <div style={{ padding: 16, backgroundColor: background, borderLeft: `4px solid ${accent_color}`, borderRadius: 4 }}>
        <Markdown>{source}</Markdown>
      </div>
    </Section>
  ),
};
