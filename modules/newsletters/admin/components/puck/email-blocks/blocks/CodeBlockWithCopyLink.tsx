/**
 * Code block with a "Copy" link in the corner. Email clients can't
 * trigger clipboard ops directly, so the link opens a hosted page
 * where the snippet can be copied with one click.
 */

import { Link, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface CodeBlockWithCopyLinkProps extends Record<string, unknown> {
  code: string;
  copy_url: string;
}

export const CodeBlockWithCopyLinkBlock: EmailBlockEntry<CodeBlockWithCopyLinkProps> = {
  componentId: 'code_block_with_copy',
  label: 'Code block (with copy link)',
  category: 'Code',
  fields: {
    code: { type: 'textarea', label: 'Code' },
    copy_url: { type: 'text', label: 'Hosted-snippet URL' },
  },
  defaultProps: {
    code: 'curl -L https://example.com/install.sh | sh',
    copy_url: 'https://example.com/snippets/install',
  },
  Component: ({ code, copy_url }) => (
    <Section style={{ padding: '20px 0' }}>
      <div style={{ position: 'relative', borderRadius: 6, backgroundColor: '#0F172A' }}>
        <Text style={{ margin: 0, padding: '8px 12px', textAlign: 'right' }}>
          <Link href={copy_url} style={{ color: '#A5B4FC', fontSize: 12, fontWeight: 600, textDecoration: 'none' }}>
            Copy snippet →
          </Link>
        </Text>
        <pre
          style={{
            margin: 0,
            padding: '0 16px 16px',
            color: '#F9FAFB',
            fontFamily: 'Menlo, Monaco, Consolas, monospace',
            fontSize: 13,
            lineHeight: '1.6',
            whiteSpace: 'pre',
            overflowX: 'auto',
          }}
        >
          {code}
        </pre>
      </div>
    </Section>
  ),
};
