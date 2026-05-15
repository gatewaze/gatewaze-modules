/**
 * Icon list — list with a leading glyph per row (✓ / • / → / ★).
 * Variant of the bare BulletList primitive that uses an emoji/glyph
 * as the bullet instead of native list markers (which render
 * inconsistently across email clients).
 */

import { Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface IconListProps extends Record<string, unknown> {
  icon: string;
  icon_color: string;
  item_1: string;
  item_2: string;
  item_3: string;
  item_4: string;
  item_5: string;
}

export const IconListBlock: EmailBlockEntry<IconListProps> = {
  componentId: 'icon_list',
  label: 'Icon list',
  category: 'Content',
  fields: {
    icon: { type: 'text', label: 'Icon (emoji / glyph)' },
    icon_color: { type: 'text', label: 'Icon colour' },
    item_1: { type: 'text', label: 'Item 1', contentEditable: true },
    item_2: { type: 'text', label: 'Item 2', contentEditable: true },
    item_3: { type: 'text', label: 'Item 3', contentEditable: true },
    item_4: { type: 'text', label: 'Item 4 (optional)', contentEditable: true },
    item_5: { type: 'text', label: 'Item 5 (optional)', contentEditable: true },
  },
  defaultProps: {
    icon: '✓',
    icon_color: '#10B981',
    item_1: 'First benefit',
    item_2: 'Second benefit',
    item_3: 'Third benefit',
    item_4: '',
    item_5: '',
  },
  Component: ({ icon, icon_color, item_1, item_2, item_3, item_4, item_5 }) => {
    const items = [item_1, item_2, item_3, item_4, item_5].filter((s) => s);
    return (
      <Section style={{ padding: '16px 0' }}>
        {items.map((text, i) => (
          <Text key={i} style={{ margin: '0 0 8px', fontSize: 15, color: '#111827' }}>
            <span style={{ color: icon_color, marginRight: 8, fontWeight: 700 }}>{icon}</span>
            {text}
          </Text>
        ))}
      </Section>
    );
  },
};
