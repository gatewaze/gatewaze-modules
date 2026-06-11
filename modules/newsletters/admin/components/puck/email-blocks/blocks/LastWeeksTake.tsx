/**
 * Last Week's Take — bordered card with an eyebrow label, heading, and
 * rich-text body. Native react-email port of the legacy `last_weeks_take`
 * Mustache block (componentId === block_type so migrated content maps).
 */

import { Heading, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { RichText } from './_richtext.js';
import { Card } from './_card.js';
import { EYEBROW, TITLE, BODY } from './_shared.js';

interface LastWeeksTakeProps extends Record<string, unknown> {
  title: string;
  body: string;
}

export const LastWeeksTakeBlock: EmailBlockEntry<LastWeeksTakeProps> = {
  componentId: 'last_weeks_take',
  label: "Last Week's Take",
  category: 'Content',
  fields: {
    title: { type: 'text', label: 'Title' },
    body: { type: 'richtext', label: 'Body' },
  },
  defaultProps: { title: '', body: '' },
  Component: ({ title, body }) => (
    <Card>
      <Text style={EYEBROW}>LAST WEEK&apos;S TAKE</Text>
      {title ? (
        <Heading as="h2" style={TITLE}>
          {title}
        </Heading>
      ) : null}
      <RichText value={body} style={BODY} />
    </Card>
  ),
};
