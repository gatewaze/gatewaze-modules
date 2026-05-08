/**
 * Phase A placeholder. Phase B adds URL validation and an internal-
 * page picker.
 */

import { createElement } from 'react';

export interface LinkFieldProps {
  value: string;
  onChange: (v: string) => void;
}

export function LinkField({ value, onChange }: LinkFieldProps) {
  return createElement('input', {
    type: 'url',
    className: 'puck-link-stub',
    value,
    placeholder: 'https://… or /path',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    'data-puck-field': 'link-stub',
  });
}
