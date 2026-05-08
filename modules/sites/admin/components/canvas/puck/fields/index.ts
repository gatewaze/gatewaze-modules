/**
 * Custom field component registry for the Puck adapter.
 *
 * One entry per `customFormat` recognised by jsonSchemaToPuckFields.
 * Each entry returns a render function shaped for Puck's `custom`
 * field type: `(props: { value, onChange }) => ReactNode`.
 *
 * Phase A ships placeholder render functions for all four formats
 * so type-checking and integration scaffolding can land. Phase B
 * replaces them with real components — Plate.js for richtext,
 * host-media picker for image, etc.
 */

import type { ReactNode } from 'react';
import type { CustomFormat } from '../json-schema-to-puck-fields.js';
import type { PuckRenderHost } from '../types.js';
import { RichTextField } from './RichTextField.js';
import { MediaField } from './MediaField.js';
import { LinkField } from './LinkField.js';
import { ColorField } from './ColorField.js';

export interface CustomFieldRenderArgs {
  value: unknown;
  onChange: (v: unknown) => void;
}

export type CustomFieldRender = (args: CustomFieldRenderArgs) => ReactNode;

export function resolveCustomField(
  format: CustomFormat,
  ctx: { renderHost: PuckRenderHost },
): CustomFieldRender {
  switch (format) {
    case 'richtext':
      return ({ value, onChange }) =>
        RichTextField({ value: typeof value === 'string' ? value : '', onChange });
    case 'image':
      return ({ value, onChange }) =>
        MediaField({
          value: typeof value === 'string' ? value : '',
          onChange,
          renderHost: ctx.renderHost,
        });
    case 'link':
      return ({ value, onChange }) =>
        LinkField({ value: typeof value === 'string' ? value : '', onChange });
    case 'color':
      return ({ value, onChange }) =>
        ColorField({ value: typeof value === 'string' ? value : '', onChange });
  }
}
