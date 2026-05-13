/**
 * Wrapper that renders a base inline editor (text/textarea/number/select/
 * radio/custom-format) alongside a "Personalize" button.
 *
 * Per spec-example-theme-deliverable §5.2 and the Puck-unification milestone:
 * any block_def field marked `x-gatewaze-personalize: true` in its JSON
 * Schema appears with this wrapper instead of the bare editor.
 *
 * Implementation note: Puck only exposes a `{ value, onChange }` API to
 * `type: 'custom'` field renders — we don't get the field name or the
 * containing block instance from the props. The wrapper reads both via:
 *   - `propName`: closed over at Config-build time (we know the schema
 *     property key when we wrap the field).
 *   - `blockInstanceId`: read at click time via Puck's `usePuck` hook,
 *     which exposes the currently-selected item id.
 *
 * The "Personalize" click bubbles up via the `PersonalizationHostContext`
 * — the same React context used to mount VariantEditor at the canvas
 * level. The wrapper never owns variant state.
 */

import * as React from 'react';
import { usePuck } from '@puckeditor/core';
import type { PuckField, CustomFormat } from '../json-schema-to-puck-fields.js';
import { usePersonalizationHost } from './personalization-host-context.js';

export interface PersonalizableFieldWrapperProps {
  /** The original PuckField — used to choose the inline editor shape. */
  field: PuckField;
  /** Top-level prop key on the containing block (e.g. "heroTitle"). */
  propName: string;
  /** Current value from Puck. */
  value: unknown;
  /** Puck's onChange. */
  onChange: (next: unknown) => void;
  /** Resolved custom-format render, if the wrapped field was `type: 'custom'`. */
  resolveCustom?: (format: CustomFormat) => (args: { value: unknown; onChange: (v: unknown) => void }) => React.ReactNode;
}

export const PersonalizableFieldWrapper: React.FC<PersonalizableFieldWrapperProps> = ({
  field,
  propName,
  value,
  onChange,
  resolveCustom,
}) => {
  const host = usePersonalizationHost();
  const puck = usePuck();
  const selectedItem = puck.appState.ui.itemSelector;
  const selectedBlockId = resolveSelectedBlockId(selectedItem, puck.appState);

  return (
    <div className="gw-personalizable-field">
      <div className="gw-personalizable-field__editor">
        {renderInlineEditor(field, value, onChange, resolveCustom)}
      </div>
      <div className="gw-personalizable-field__actions">
        <button
          type="button"
          className="gw-personalizable-field__personalize"
          disabled={!host || !selectedBlockId}
          onClick={() => {
            if (!host || !selectedBlockId) return;
            host.openVariantEditor({ blockInstanceId: selectedBlockId, propName });
          }}
          title={
            !selectedBlockId
              ? 'Select a block first'
              : !host
              ? 'Personalization host not mounted'
              : `Edit per-persona variants for ${propName}`
          }
        >
          Personalize
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Inline editor dispatch
// ---------------------------------------------------------------------------

function renderInlineEditor(
  field: PuckField,
  value: unknown,
  onChange: (next: unknown) => void,
  resolveCustom?: (format: CustomFormat) => (args: { value: unknown; onChange: (v: unknown) => void }) => React.ReactNode,
): React.ReactNode {
  switch (field.type) {
    case 'text':
      return (
        <input
          type="text"
          className="gw-personalizable-field__input"
          value={asString(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'textarea':
      return (
        <textarea
          className="gw-personalizable-field__textarea"
          rows={4}
          value={asString(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'number':
      return (
        <input
          type="number"
          className="gw-personalizable-field__input"
          value={asNumber(value)}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange(Number.isFinite(n) ? n : 0);
          }}
        />
      );
    case 'select':
      return (
        <select
          className="gw-personalizable-field__select"
          value={asString(value)}
          onChange={(e) => onChange(coerceOptionValue(e.target.value, field.options))}
        >
          {field.options.map((opt, i) => (
            <option key={`${String(opt.value)}-${i}`} value={String(opt.value)}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    case 'radio':
      return (
        <div className="gw-personalizable-field__radio-group">
          {field.options.map((opt, i) => (
            <label key={`${String(opt.value)}-${i}`} className="gw-personalizable-field__radio">
              <input
                type="radio"
                checked={value === opt.value}
                onChange={() => onChange(opt.value)}
              />
              {opt.label}
            </label>
          ))}
        </div>
      );
    case 'custom': {
      const resolved = resolveCustom?.(field.customFormat);
      if (!resolved) {
        // No custom resolver — fall back to text.
        return (
          <input
            type="text"
            className="gw-personalizable-field__input"
            value={asString(value)}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      }
      return <>{resolved({ value, onChange })}</>;
    }
    case 'array':
    case 'object':
      // Object / array fields don't get an inline editor here — Puck
      // renders nested fields with their own personalize affordances.
      // For now we surface a hint; future work: per-array-item or whole-
      // array variant authoring (matrix tab covers this discovery path).
      return (
        <p className="gw-personalizable-field__hint">
          Edit nested fields inline — personalisation is per leaf field.
        </p>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function asNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function coerceOptionValue(
  raw: string,
  options: ReadonlyArray<{ value: string | number | boolean }>,
): string | number | boolean {
  const match = options.find((o) => String(o.value) === raw);
  return match ? match.value : raw;
}

/**
 * Resolve the currently-selected block instance id from Puck's app state.
 * Returns null when nothing is selected (root config view) or when the
 * selection is a slot that doesn't map to a block id we recognise.
 *
 * Puck's `zone` is optional: undefined / `'default-zone'` mean the
 * top-level content array; any other string is a named zone (e.g. a
 * brick slot). When `id` was injected by pageBlocksToPuckData (which
 * carries the page_blocks row id through into Puck props), that's the
 * value we surface to VariantEditor as the variant target.
 */
function resolveSelectedBlockId(
  selector: { index: number; zone?: string } | null | undefined,
  appState: ReturnType<typeof usePuck>['appState'],
): string | null {
  if (!selector) return null;
  const zone = selector.zone;
  const content =
    !zone || zone === 'default-zone'
      ? appState.data.content
      : appState.data.zones?.[zone];
  const item = content?.[selector.index];
  const propsId = (item?.props as { id?: unknown } | undefined)?.id;
  return typeof propsId === 'string' ? propsId : null;
}
