/**
 * MLOps Community — bordered card that hosts community "bricks" (podcast,
 * blog post, reading group, generic section) in a slot. Native react-email
 * port of the legacy bricked `mlops_community` block. editionToPuckData feeds
 * the edition's bricks into `children`, and EditionEmail does the same for the
 * export, so the brick components render inside this card.
 */

import { Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { renderSlot } from '../render-slot.js';
import { Card } from './_card.js';
import { EYEBROW } from './_shared.js';

interface MlopsCommunityProps extends Record<string, unknown> {
  children?: unknown;
}

export const MlopsCommunityBlock: EmailBlockEntry<MlopsCommunityProps> = {
  componentId: 'mlops_community',
  label: 'MLOps Community',
  category: 'MLOps Template',
  fields: {
    children: { type: 'slot', label: 'Bricks' },
  },
  defaultProps: { children: [] },
  Component: ({ children }) => (
    <Card>
      <Text style={EYEBROW}>MLOPS COMMUNITY</Text>
      {renderSlot(children)}
    </Card>
  ),
};
