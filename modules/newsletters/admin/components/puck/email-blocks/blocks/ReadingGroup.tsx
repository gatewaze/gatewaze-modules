/**
 * Reading Group brick — title, rich-text description, and a "Watch it here"
 * link. A community brick rendered inside the MLOps Community slot.
 */

import { Section, Heading, Text, Link, Hr } from '@react-email/components';
import type { Field } from '@puckeditor/core';
import type { EmailBlockEntry } from '../registry-types.js';
import { normalizeRichText } from '../rich-text.js';
import { BODY, LINK, BRICK_TITLE, DIVIDER } from './_shared.js';

interface ReadingGroupProps extends Record<string, unknown> {
  title: string;
  description: string;
  watch_link: string;
  link_text: string;
}

export const ReadingGroupBlock: EmailBlockEntry<ReadingGroupProps> = {
  componentId: 'reading_group',
  label: 'Reading Group (brick)',
  category: 'Community',
  fields: {
    title: { type: 'text', label: 'Title' },
    description: { type: 'custom', customFormat: 'richtext', label: 'Description' } as Field,
    watch_link: { type: 'text', label: 'Watch link' },
    link_text: { type: 'text', label: 'Link text' },
  },
  defaultProps: { title: '', description: '', watch_link: '', link_text: 'Watch it here' },
  Component: ({ title, description, watch_link, link_text }) => (
    <Section style={{ padding: '0 15px' }}>
      {title ? (
        <Heading as="h3" style={BRICK_TITLE}>
          {title}
        </Heading>
      ) : null}
      <div style={BODY} dangerouslySetInnerHTML={{ __html: normalizeRichText(description) }} />
      {watch_link ? (
        <Text style={{ ...BODY, marginTop: '8px' }}>
          <strong>
            <Link href={watch_link} style={LINK}>
              {link_text || 'Watch it here'}
            </Link>
          </strong>
        </Text>
      ) : null}
      <Hr style={DIVIDER} />
    </Section>
  ),
};
