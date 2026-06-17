/**
 * Generic Section brick — an optional eyebrow label + title, a rich-text body
 * (often a list of events/links), and an optional CTA link. A flexible
 * community brick rendered inside the MLOps Community slot.
 */

import { Section, Heading, Text, Link, Hr } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { RichText } from './_richtext.js';
import { EYEBROW, BODY, LINK, BRICK_TITLE, DIVIDER } from './_shared.js';

interface GenericSectionProps extends Record<string, unknown> {
  section_title: string;
  title: string;
  description: string;
  link: string;
  link_text: string;
  /** Set by renderTree for the last brick in the slot — suppresses the
   *  trailing divider so the line only appears BETWEEN bricks. */
  _last?: boolean;
}

export const GenericSectionBlock: EmailBlockEntry<GenericSectionProps> = {
  componentId: 'generic_section',
  label: 'Generic Section (brick)',
  category: 'MLOps Template',
  fields: {
    section_title: { type: 'text', label: 'Eyebrow label' },
    title: { type: 'text', label: 'Title' },
    description: { type: 'richtext', label: 'Description' },
    link: { type: 'text', label: 'Link URL' },
    link_text: { type: 'text', label: 'Link text' },
  },
  defaultProps: { section_title: '', title: '', description: '', link: '', link_text: '' },
  Component: ({ section_title, title, description, link, link_text, _last }) => (
    // No horizontal padding: the MLOps Community Card already insets content
    // 15px, so the brick adding its own 15px double-indented it and pushed the
    // title out of line with the block's eyebrow. Let the Card own the inset.
    <Section style={{ padding: 0 }}>
      {section_title ? <Text style={{ ...EYEBROW, textTransform: 'uppercase' }}>{section_title}</Text> : null}
      {title ? (
        <Heading as="h3" style={BRICK_TITLE}>
          {title}
        </Heading>
      ) : null}
      <RichText value={description} style={BODY} />
      {link && link_text ? (
        <Text style={{ ...BODY, marginTop: '8px' }}>
          <strong>
            <Link href={link} style={LINK}>
              {link_text}
            </Link>
          </strong>
        </Text>
      ) : null}
      {_last ? null : <Hr style={DIVIDER} />}
    </Section>
  ),
};
