/**
 * Markdown content — operator writes markdown, the block renders it
 * via @react-email/components' `Markdown` component. Suited for
 * developer-facing newsletters where authors prefer markdown over
 * the rich-text editor.
 */

import { Markdown, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface MarkdownContentProps extends Record<string, unknown> {
  source: string;
}

export const MarkdownContentBlock: EmailBlockEntry<MarkdownContentProps> = {
  componentId: 'markdown_content',
  label: 'Markdown',
  category: 'Content',
  fields: {
    // `contentEditable: false` is required here: the universal-inline-
    // editing default in merge-into-config.tsx wraps `text`/`textarea`
    // prop values in a structured node so Puck can intercept edits.
    // That structure isn't a string — but `<Markdown>` (and the marked
    // parser underneath it) expects a string. Forcing the raw string
    // through requires opting out of inline editing for this field.
    source: { type: 'textarea', label: 'Markdown source', contentEditable: false },
  },
  defaultProps: {
    source: '## Markdown heading\n\nA paragraph of **bold** and *italic* text.\n\n- One\n- Two\n- Three',
  },
  Component: ({ source }) => (
    <Section style={{ padding: '16px 0' }}>
      <Markdown>{source}</Markdown>
    </Section>
  ),
};
