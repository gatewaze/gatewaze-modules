/**
 * Phase A placeholder for the host-media picker. Phase B opens the
 * real media modal (host-media module) on click and writes back the
 * chosen URL via `onChange`.
 */

import { createElement } from 'react';
import type { PuckRenderHost } from '../types.js';

export interface MediaFieldProps {
  value: string;
  onChange: (v: string) => void;
  renderHost: PuckRenderHost;
}

export function MediaField({ value, onChange, renderHost }: MediaFieldProps) {
  return createElement(
    'div',
    { className: 'puck-media-stub', 'data-puck-field': 'media-stub' },
    createElement('input', {
      type: 'text',
      value,
      placeholder: 'Image URL',
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    }),
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => renderHost.showMediaPicker((url: string) => onChange(url)),
      },
      'Pick…',
    ),
  );
}
