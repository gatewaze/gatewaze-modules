/**
 * Code block with a filename tab — looks like a code panel in an IDE,
 * with the filename rendered as a header strip above the code.
 */

import { Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface CodeBlockWithFilenameProps extends Record<string, unknown> {
  filename: string;
  code: string;
}

export const CodeBlockWithFilenameBlock: EmailBlockEntry<CodeBlockWithFilenameProps> = {
  componentId: 'code_block_with_filename',
  label: 'Code block (with filename)',
  category: 'Code',
  fields: {
    filename: { type: 'text', label: 'Filename' },
    code: { type: 'textarea', label: 'Code' },
  },
  defaultProps: {
    filename: 'server.ts',
    code: 'export default function handler() {\n  return new Response("ok");\n}',
  },
  Component: ({ filename, code }) => (
    <Section style={{ padding: '20px 0' }}>
      <Text style={{ margin: 0, padding: '8px 12px', backgroundColor: '#1F2937', color: '#D1D5DB', fontFamily: 'Menlo, Monaco, Consolas, monospace', fontSize: 12, borderRadius: '6px 6px 0 0' }}>
        {filename}
      </Text>
      <pre
        style={{
          margin: 0,
          padding: 16,
          backgroundColor: '#0F172A',
          color: '#F9FAFB',
          fontFamily: 'Menlo, Monaco, Consolas, monospace',
          fontSize: 13,
          lineHeight: '1.6',
          borderRadius: '0 0 6px 6px',
          whiteSpace: 'pre',
          overflowX: 'auto',
        }}
      >
        {code}
      </pre>
    </Section>
  ),
};
