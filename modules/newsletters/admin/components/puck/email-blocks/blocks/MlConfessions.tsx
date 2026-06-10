/**
 * ML Confessions — bordered card with an anonymous confession story and a
 * link to submit one. Native react-email port of the legacy `ml_confessions`
 * Mustache block.
 */

import { Heading, Text, Link } from '@react-email/components';
import type { Field } from '@puckeditor/core';
import type { EmailBlockEntry } from '../registry-types.js';
import { normalizeRichText } from '../rich-text.js';
import { Card } from './_card.js';
import { EYEBROW, TITLE, BODY, LINK } from './_shared.js';

interface MlConfessionsProps extends Record<string, unknown> {
  title: string;
  story: string;
  confess_link: string;
}

const FALLBACK_LINK = 'https://forms.gle/8EDvXGizxyFVKfwy8';

export const MlConfessionsBlock: EmailBlockEntry<MlConfessionsProps> = {
  componentId: 'ml_confessions',
  label: 'ML Confessions',
  category: 'Content',
  fields: {
    title: { type: 'text', label: 'Title' },
    story: { type: 'custom', customFormat: 'richtext', label: 'Story' } as Field,
    confess_link: { type: 'text', label: 'Confession form link' },
  },
  defaultProps: { title: '', story: '', confess_link: FALLBACK_LINK },
  Component: ({ title, story, confess_link = FALLBACK_LINK }) => (
    <Card>
      <Text style={EYEBROW}>ML CONFESSIONS</Text>
      {title ? (
        <Heading as="h2" style={TITLE}>
          {title}
        </Heading>
      ) : null}
      <div style={BODY} dangerouslySetInnerHTML={{ __html: normalizeRichText(story) }} />
      <Text style={{ ...BODY, marginTop: '12px' }}>
        {'Share your confession '}
        <strong>
          <Link href={confess_link} style={LINK}>
            here
          </Link>
        </strong>
        .
      </Text>
    </Card>
  ),
};
