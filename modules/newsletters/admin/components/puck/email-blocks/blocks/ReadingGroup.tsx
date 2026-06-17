/**
 * Reading Group brick — title, rich-text description, and a "Watch it here"
 * link. A community brick rendered inside the MLOps Community slot.
 */

import { Section, Heading, Text, Link, Hr } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { RichText } from './_richtext.js';
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
  category: 'MLOps Template',
  fields: {
    title: { type: 'text', label: 'Title' },
    description: { type: 'richtext', label: 'Description' },
    watch_link: { type: 'text', label: 'Watch link' },
    link_text: { type: 'text', label: 'Link text' },
  },
  defaultProps: { title: '', description: '', watch_link: '', link_text: 'Watch it here' },
  Component: ({ title, description, watch_link, link_text, _last }) => (
    <Section style={{ padding: 0 }}>
      {title ? (
        <Heading as="h3" style={BRICK_TITLE}>
          {title}
        </Heading>
      ) : null}
      <RichText value={description} style={BODY} />
      {watch_link ? (
        <Text style={{ ...BODY, marginTop: '8px' }}>
          <strong>
            <Link href={watch_link} style={LINK}>
              {link_text || 'Watch it here'}
            </Link>
          </strong>
        </Text>
      ) : null}
      {_last ? null : <Hr style={DIVIDER} />}
    </Section>
  ),
};
