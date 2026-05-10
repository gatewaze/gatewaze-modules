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
    // react-email's Container renders as a <table> + <tbody> + <tr> +
    // <td>; applying `padding` to the outer table style lands on the
    // <table> element, which doesn't push the inner <td> content
    // inward visually. Move the padding onto a wrapper around the
    // slot's children so the spacing actually surrounds the rendered
    // content (canvas + production HTML stay aligned). The wrapper is
    // a plain <div> — supported in every modern mail client; Outlook
    // (which wants tables) is unaffected because we're inside the
    // Container's <td> already.
    <Container
      style={{
        maxWidth: `${maxWidth}px`,
        margin: '0 auto',
        backgroundColor: background,
      }}
    >
      <div style={{ padding }}>{renderSlot(children)}</div>
    </Container>
  ),
};
