/**
 * Phase A placeholder. Phase B adds a real color picker.
 */

import { createElement } from 'react';

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export interface ColorFieldProps {
  value: string;
  onChange: (v: string) => void;
}

export function ColorField({ value, onChange }: ColorFieldProps) {
  const valid = value === '' || HEX.test(value);
  return createElement(
    'div',
    { className: 'puck-color-stub', 'data-puck-field': 'color-stub' },
    createElement('input', {
      type: 'text',
      value,
      placeholder: '#rrggbb',
      'aria-invalid': !valid,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    }),
  );
}
