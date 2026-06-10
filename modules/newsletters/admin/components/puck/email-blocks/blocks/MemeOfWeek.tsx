/**
 * Meme of the Week — bordered card with a label and a single image. Native
 * react-email port of the legacy `meme_of_week` Mustache block.
 */

import { Section, Text, Img } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { BORDERED_CARD, EYEBROW } from './_shared.js';

interface MemeOfWeekProps extends Record<string, unknown> {
  image_url: string;
}

export const MemeOfWeekBlock: EmailBlockEntry<MemeOfWeekProps> = {
  componentId: 'meme_of_week',
  label: 'Meme of the Week',
  category: 'Content',
  fields: {
    image_url: { type: 'text', label: 'Meme image URL' },
  },
  defaultProps: { image_url: '' },
  Component: ({ image_url }) => (
    <Section style={BORDERED_CARD}>
      <Text style={EYEBROW}>MEME OF THE WEEK</Text>
      {image_url ? (
        <Img
          src={image_url}
          alt=""
          style={{ display: 'block', width: '100%', maxWidth: '100%', height: 'auto', border: 0 }}
        />
      ) : null}
    </Section>
  ),
};
