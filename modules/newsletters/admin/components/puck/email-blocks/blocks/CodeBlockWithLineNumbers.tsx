/**
 * Code block with line numbers rendered down the left edge. Email
 * clients don't support CSS counters reliably, so we inline the
 * numbers as a separate column.
 */

import { Column, Row, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface CodeBlockWithLineNumbersProps extends Record<string, unknown> {
  code: string;
}

export const CodeBlockWithLineNumbersBlock: EmailBlockEntry<CodeBlockWithLineNumbersProps> = {
  componentId: 'code_block_with_line_numbers',
  label: 'Code block (with line numbers)',
  category: 'Code',
  fields: {
    // contentEditable disabled — render does `code.split('\n')` which
    // needs a raw string; the universal inline-edit wrapper turns the
    // prop into an object. Operators edit via the drawer textarea.
    code: { type: 'textarea', label: 'Code', contentEditable: false },
  },
  defaultProps: {
    code: 'function add(a, b) {\n  return a + b;\n}\nconsole.log(add(1, 2));',
  },
  Component: ({ code }) => {
    const lines = code.split('\n');
    return (
      <Section style={{ padding: '20px 0' }}>
        <Row>
          <Column
            style={{
              width: 40,
              padding: '16px 8px',
              backgroundColor: '#1E293B',
              color: '#64748B',
              fontFamily: 'Menlo, Monaco, Consolas, monospace',
              fontSize: 13,
              lineHeight: '1.6',
              textAlign: 'right',
              borderRadius: '6px 0 0 6px',
              verticalAlign: 'top',
            }}
          >
            {lines.map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </Column>
          <Column
            style={{
              padding: 16,
              backgroundColor: '#0F172A',
              color: '#F9FAFB',
              fontFamily: 'Menlo, Monaco, Consolas, monospace',
              fontSize: 13,
              lineHeight: '1.6',
              borderRadius: '0 6px 6px 0',
              verticalAlign: 'top',
            }}
          >
            {lines.map((l, i) => (
              <div key={i} style={{ whiteSpace: 'pre' }}>{l || ' '}</div>
            ))}
          </Column>
        </Row>
      </Section>
    );
  },
};
