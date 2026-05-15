/**
 * Inline code with a leading label — "Try:" or "Use:" prefix shown
 * in muted text alongside the snippet.
 */

import { Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface CodeInlineWithLabelProps extends Record<string, unknown> {
  label: string;
  code: string;
}

export const CodeInlineWithLabelBlock: EmailBlockEntry<CodeInlineWithLabelProps> = {
  componentId: 'code_inline_with_label',
  label: 'Inline code (with label)',
  category: 'Code',
  fields: {
    label: { type: 'text', label: 'Label' },
    code: { type: 'text', label: 'Code snippet' },
  },
  defaultProps: { label: 'Run', code: 'npx create-gatewaze@latest' },
  Component: ({ label, code }) => (
    <Section style={{ padding: '12px 0' }}>
      <Text style={{ margin: 0, fontSize: 13 }}>
        <span style={{ color: '#6B7280', textTransform: 'uppercase', letterSpacing: 1, fontSize: 11, fontWeight: 600, marginRight: 8 }}>
          {label}
        </span>
        <code style={{ fontFamily: 'Menlo, Monaco, Consolas, monospace', fontSize: 13, backgroundColor: '#0F172A', color: '#F9FAFB', padding: '4px 10px', borderRadius: 4 }}>
          {code}
        </code>
      </Text>
    </Section>
  ),
};
