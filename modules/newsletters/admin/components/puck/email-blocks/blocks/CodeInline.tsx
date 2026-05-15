/**
 * Inline code snippet — single-line, monospace, lightly styled.
 * Suited for changelog-style mentions like "use `--flag` to enable".
 */

import { Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface CodeInlineProps extends Record<string, unknown> {
  text: string;
  code: string;
  trail: string;
}

export const CodeInlineBlock: EmailBlockEntry<CodeInlineProps> = {
  componentId: 'code_inline',
  label: 'Inline code',
  category: 'Code',
  fields: {
    text: { type: 'text', label: 'Leading text' },
    code: { type: 'text', label: 'Code snippet' },
    trail: { type: 'text', label: 'Trailing text' },
  },
  defaultProps: {
    text: 'Run',
    code: 'npm install gatewaze',
    trail: 'to get started.',
  },
  Component: ({ text, code, trail }) => (
    <Section style={{ padding: '12px 0' }}>
      <Text style={{ margin: 0, fontSize: 14, color: '#111827', lineHeight: '1.6' }}>
        {text}{' '}
        <code style={{ fontFamily: 'Menlo, Monaco, Consolas, monospace', fontSize: 13, backgroundColor: '#F3F4F6', padding: '2px 6px', borderRadius: 4, color: '#1F2937' }}>
          {code}
        </code>{' '}
        {trail}
      </Text>
    </Section>
  ),
};
