/**
 * Markdown changelog — version header + date + markdown body. Common
 * release-notes pattern.
 */

import { Markdown, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface MarkdownChangelogProps extends Record<string, unknown> {
  version: string;
  date: string;
  source: string;
}

export const MarkdownChangelogBlock: EmailBlockEntry<MarkdownChangelogProps> = {
  componentId: 'markdown_changelog',
  label: 'Markdown changelog',
  category: 'Content',
  fields: {
    version: { type: 'text', label: 'Version' },
    date: { type: 'text', label: 'Release date' },
    // contentEditable disabled — marked() requires a raw string; see MarkdownContent.tsx.
    source: { type: 'textarea', label: 'Markdown body', contentEditable: false },
  },
  defaultProps: {
    version: 'v1.2.0',
    date: 'May 11, 2026',
    source: '### Added\n- New weather block for personalised forecasts\n\n### Fixed\n- Spacing wrapper now applies in publish path',
  },
  Component: ({ version, date, source }) => (
    <Section style={{ padding: '24px 0', borderTop: '1px solid #E5E7EB' }}>
      <Text style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700, color: '#111827' }}>{version}</Text>
      <Text style={{ margin: '0 0 16px', fontSize: 12, color: '#6B7280' }}>{date}</Text>
      <Markdown>{source}</Markdown>
    </Section>
  ),
};
