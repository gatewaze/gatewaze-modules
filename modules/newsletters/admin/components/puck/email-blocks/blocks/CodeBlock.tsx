/**
 * Multi-line code block — dark panel with monospace text. No syntax
 * highlighting (email clients strip <span> styles inconsistently; a
 * single `<pre>` with plain text is the most portable option).
 */

import { Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface CodeBlockProps extends Record<string, unknown> {
  code: string;
  language: string;
}

const PRE_STYLE = {
  margin: 0,
  padding: 16,
  backgroundColor: '#0F172A',
  color: '#F9FAFB',
  fontFamily: 'Menlo, Monaco, Consolas, monospace',
  fontSize: 13,
  lineHeight: '1.6',
  borderRadius: 6,
  whiteSpace: 'pre' as const,
  overflowX: 'auto' as const,
};

export const CodeBlockBlock: EmailBlockEntry<CodeBlockProps> = {
  componentId: 'code_block',
  label: 'Code block',
  category: 'Code',
  fields: {
    code: { type: 'textarea', label: 'Code' },
    language: { type: 'text', label: 'Language label (display-only)' },
  },
  defaultProps: {
    code: 'const greet = (name) => `Hello, ${name}!`;\nconsole.log(greet("world"));',
    language: 'javascript',
  },
  Component: ({ code }) => (
    <Section style={{ padding: '20px 0' }}>
      <pre style={PRE_STYLE}>{code}</pre>
    </Section>
  ),
};
