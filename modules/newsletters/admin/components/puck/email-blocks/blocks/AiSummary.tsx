/**
 * AI Summary — optional heading + AI-generated rich-text section. Native
 * react-email port of the `ai_summary` block. The `ai_body` field is a
 * richtext field for now (the dedicated AI-prompt field is a follow-up; see
 * HelixAiContent for the richer AI editing surface).
 */

import { Section, Heading } from '@react-email/components';
import type { Field } from '@puckeditor/core';
import type { EmailBlockEntry } from '../registry-types.js';
import { normalizeRichText } from '../rich-text.js';
import { COLUMN, BODY } from './_shared.js';

interface AiSummaryProps extends Record<string, unknown> {
  section_title: string;
  ai_body: string;
}

export const AiSummaryBlock: EmailBlockEntry<AiSummaryProps> = {
  componentId: 'ai_summary',
  label: 'AI Summary',
  category: 'Content',
  fields: {
    section_title: { type: 'text', label: 'Section title' },
    ai_body: { type: 'custom', customFormat: 'richtext', label: 'Content' } as Field,
  },
  defaultProps: { section_title: '', ai_body: '' },
  Component: ({ section_title, ai_body }) => (
    <Section style={COLUMN}>
      <div style={{ padding: '20px 15px' }}>
        {section_title ? (
          <Heading as="h2" style={{ margin: '0 0 16px', fontSize: '22px', fontWeight: 'bold', color: '#1a1a2e' }}>
            {section_title}
          </Heading>
        ) : null}
        <div style={{ ...BODY, fontSize: '16px', lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: normalizeRichText(ai_body) }} />
      </div>
    </Section>
  ),
};
