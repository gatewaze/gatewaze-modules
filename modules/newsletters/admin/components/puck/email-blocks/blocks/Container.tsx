/**
 * Container primitive — react-email's `Container` (the
 * `max-width`-constrained outer wrapper that frames the email body).
 *
 * Slot field accepts any other registry block as a child; useful as the
 * top-level scaffold for a JSX-tree authored edition. Multiple
 * Containers in one edition are allowed but uncommon.
 */

import { Container } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { renderSlot } from '../render-slot.js';

interface ContainerProps extends Record<string, unknown> {
  maxWidth: string;
  padding: string;
  background: string;
  children?: unknown;
}

export const ContainerBlock: EmailBlockEntry<ContainerProps> = {
  componentId: 'container',
  label: 'Container',
  category: 'Layout',
  fields: {
    maxWidth: { type: 'text', label: 'Max width (px)' },
    padding: { type: 'text', label: 'Padding (CSS)' },
    background: { type: 'text', label: 'Background colour' },
    children: { type: 'slot', label: 'Contents' },
  },
  defaultProps: {
    maxWidth: '600',
    padding: '24px',
    background: 'transparent',
    children: [],
  },
  Component: ({ maxWidth, padding, background, children }) => (
    <Container
      style={{
        maxWidth: `${maxWidth}px`,
        margin: '0 auto',
        padding,
        backgroundColor: background,
      }}
    >
      {renderSlot(children)}
    </Container>
  ),
};
