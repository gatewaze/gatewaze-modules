/**
 * Meme of the Week — bordered card with a label and a single image. Native
 * react-email port of the legacy `meme_of_week` Mustache block.
 */

import { Text, Img } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';
import { Card } from './_card.js';
import { EYEBROW } from './_shared.js';

interface MemeOfWeekProps extends Record<string, unknown> {
  image_url: string;
}

export const MemeOfWeekBlock: EmailBlockEntry<MemeOfWeekProps> = {
  componentId: 'meme_of_week',
  label: 'Meme of the Week',
  category: 'MLOps Template',
  fields: {
    image_url: { type: 'custom', label: 'Meme image', render: NewsletterImageFieldAdapter as never },
  },
  defaultProps: { image_url: '' },
  Component: ({ image_url }) => (
    <Card>
      <Text style={EYEBROW}>MEME OF THE WEEK</Text>
      {image_url ? (
        <Img
          src={image_url}
          alt=""
          style={{ display: 'block', width: '100%', maxWidth: '100%', height: 'auto', border: 0 }}
        />
      ) : null}
    </Card>
  ),
};
