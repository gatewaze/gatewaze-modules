/**
 * How We Can Help — closing CTA card. Native react-email port of the legacy
 * `how_we_help` Mustache block (which was effectively static; here the title
 * and body are editable rich text with the original copy as defaults).
 */

import { Heading, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { RichText } from './_richtext.js';
import { Card } from './_card.js';
import { EYEBROW, TITLE, BODY } from './_shared.js';

interface HowWeHelpProps extends Record<string, unknown> {
  title: string;
  body: string;
}

const DEFAULT_BODY =
  '<p>Working on something tricky or planning ahead? Here’s how we can help - just hit reply:</p>' +
  '<ul>' +
  '<li>Custom workshops tailored to your company’s needs</li>' +
  '<li>Hiring? I know some quality folks looking for a new adventure</li>' +
  '<li>Want to connect with someone tackling similar problems? I can introduce you</li>' +
  '</ul>' +
  '<p>Thanks for reading, catch you next time!</p>';

export const HowWeHelpBlock: EmailBlockEntry<HowWeHelpProps> = {
  componentId: 'how_we_help',
  label: 'How We Can Help',
  category: 'MLOps Template',
  fields: {
    title: { type: 'text', label: 'Title' },
    body: { type: 'richtext', label: 'Body' },
  },
  defaultProps: { title: 'Making the hard stuff simpler', body: DEFAULT_BODY },
  Component: ({ title = 'Making the hard stuff simpler', body = DEFAULT_BODY }) => (
    <Card>
      <Text style={EYEBROW}>HOW WE CAN HELP</Text>
      {title ? (
        <Heading as="h2" style={TITLE}>
          {title}
        </Heading>
      ) : null}
      <RichText value={body} style={BODY} />
    </Card>
  ),
};
