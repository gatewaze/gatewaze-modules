/**
 * Last Week's Take — bordered card with an eyebrow label, heading, and
 * rich-text body. Native react-email port of the legacy `last_weeks_take`
 * Mustache block (componentId === block_type so migrated content maps).
 */

import { Section, Heading, Text } from '@react-email/components';
import type { Field } from '@puckeditor/core';
import type { EmailBlockEntry } from '../registry-types.js';
import { normalizeRichText } from '../rich-text.js';

interface LastWeeksTakeProps extends Record<string, unknown> {
  title: string;
  body: string;
}

const CARD = {
  border: '1px solid #4086c6',
  borderRadius: '15px',
  width: '650px',
  maxWidth: '650px',
  margin: '0 auto',
  color: '#000',
  padding: '15px',
} as const;

const EYEBROW = { margin: 0, fontSize: '12px', color: '#4086c6', fontWeight: 'bold' as const };
const TITLE = { margin: '0 0 8px', fontSize: '24px', fontWeight: 'bold' as const, color: '#000', lineHeight: 1.2 };
const BODY = { fontSize: '16px', color: '#555', lineHeight: 1.5 } as const;

export const LastWeeksTakeBlock: EmailBlockEntry<LastWeeksTakeProps> = {
  componentId: 'last_weeks_take',
  label: "Last Week's Take",
  category: 'Content',
  fields: {
    title: { type: 'text', label: 'Title' },
    body: { type: 'custom', customFormat: 'richtext', label: 'Body' } as Field,
  },
  defaultProps: { title: '', body: '' },
  Component: ({ title, body }) => (
    <Section style={CARD}>
      <Text style={EYEBROW}>LAST WEEK&apos;S TAKE</Text>
      {title ? (
        <Heading as="h2" style={TITLE}>
          {title}
        </Heading>
      ) : null}
      <div style={BODY} dangerouslySetInnerHTML={{ __html: normalizeRichText(body) }} />
    </Section>
  ),
};
