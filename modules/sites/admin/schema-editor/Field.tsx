/**
 * Single-field renderer for the schema-driven editor.
 *
 * Pure: no global state, no module-level state, no DB calls. The field
 * receives its (value, schema, onChange) and emits the new value upward.
 *
 * Field kinds dispatched to:
 *   text       <input type="text">
 *   textarea   <textarea>
 *   html       <textarea> placeholder for the rich-text editor
 *              (the consuming admin app swaps in its own RichText widget
 *              by overriding via the FieldRendererMap prop on SchemaEditor)
 *   media-url  <input type="url"> + a "pick from media library" button
 *              (placeholder; the admin app's media-picker hook is injected
 *              via FieldRendererMap)
 *   number     <input type="number" step="any">
 *   integer    <input type="number" step="1">
 *   boolean    <input type="checkbox">
 *   select     <select> populated from schema.enum
 *   object     fieldset that recurses into the object's properties
 *   array      list of entries with add/remove
 *
 * Personalizable fields render their normal editor + a "Personalize" button
 * that emits a {pointer, contextKey} pair to the parent. The variant editor
 * lives outside this component.
 */

import * as React from 'react';
import {
  classifyEditorKind,
  walkFields,
  buildDefault,
  type SchemaNode,
  type FieldEditorKind,
} from './walk-schema.js';

export interface FieldRendererContext {
  /** Path used by the rich-text / media-picker / variant integrations. */
  pointer: string;
  /** Locale for date / number formatting; the consumer can override. */
  locale?: string;
}

export type FieldRenderer<V = unknown> = (props: {
  value: V;
  schema: SchemaNode;
  onChange: (next: V) => void;
  ctx: FieldRendererContext;
}) => React.ReactNode;

export type FieldRendererMap = Partial<Record<FieldEditorKind, FieldRenderer>>;

export interface FieldProps {
  pointer: string;
  schema: SchemaNode;
  value: unknown;
  onChange: (next: unknown) => void;
  /** Personalize callback (when the field is x-gatewaze-personalize). */
  onPersonalize?: (pointer: string) => void;
  /** Renderer overrides keyed by editor kind — takes precedence over built-ins. */
  renderers?: FieldRendererMap;
}

export const Field: React.FC<FieldProps> = ({ pointer, schema, value, onChange, onPersonalize, renderers }) => {
  const kind = classifyEditorKind(schema);
  const overridden = renderers?.[kind];
  const ctx: FieldRendererContext = { pointer };
  const personalizable = schema['x-gatewaze-personalize'] === true;

  const editor: React.ReactNode = overridden
    ? overridden({ value, schema, onChange, ctx } as Parameters<FieldRenderer>[0])
    : renderBuiltin(kind, value, schema, onChange, renderers);

  return (
    <div className="gw-field" data-pointer={pointer}>
      <label className="gw-field__label">
        <span>{typeof schema.title === 'string' ? schema.title : labelFromPointer(pointer)}</span>
        {personalizable && onPersonalize && (
          <button type="button" className="gw-field__personalize" onClick={() => onPersonalize(pointer)}>
            Personalize
          </button>
        )}
      </label>
      {schema.description && <small className="gw-field__desc">{schema.description}</small>}
      {editor}
    </div>
  );
};

function renderBuiltin(
  kind: FieldEditorKind,
  value: unknown,
  schema: SchemaNode,
  onChange: (next: unknown) => void,
  renderers: FieldRendererMap | undefined,
): React.ReactNode {
  switch (kind) {
    case 'text': return <TextEditor value={asString(value)} onChange={onChange} />;
    case 'textarea': return <TextAreaEditor value={asString(value)} onChange={onChange} />;
    case 'html': return <HtmlEditor value={asString(value)} onChange={onChange} />;
    case 'media-url': return <MediaUrlEditor value={asString(value)} onChange={onChange} />;
    case 'number': return <NumberEditor value={asNumber(value)} onChange={(n) => onChange(n)} step="any" />;
    case 'integer': return <NumberEditor value={asNumber(value)} onChange={(n) => onChange(Math.trunc(n))} step="1" />;
    case 'boolean': return <BooleanEditor value={asBool(value)} onChange={onChange} />;
    case 'select': return <SelectEditor value={asString(value)} options={(schema.enum ?? []) as ReadonlyArray<unknown>} onChange={onChange} />;
    case 'object': return <ObjectEditor value={value as Record<string, unknown> | null} schema={schema} onChange={onChange} renderers={renderers} />;
    case 'array': return <ArrayEditor value={(value as unknown[] | null) ?? []} schema={schema} onChange={onChange} renderers={renderers} />;
    default: return <em className="gw-field__unknown">unsupported field kind</em>;
  }
}

// ---------------------------------------------------------------------------
// Built-in editors
// ---------------------------------------------------------------------------

const TextEditor: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => (
  <input
    type="text"
    className="gw-field__input"
    value={value}
    onChange={(e) => onChange(e.target.value)}
  />
);

const TextAreaEditor: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => (
  <textarea
    className="gw-field__textarea"
    value={value}
    rows={6}
    onChange={(e) => onChange(e.target.value)}
  />
);

const HtmlEditor: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => (
  // Placeholder. The admin app will override via renderers={{ html: AdminRichTextEditor }}.
  <textarea
    className="gw-field__html-textarea"
    value={value}
    rows={10}
    placeholder="HTML content"
    onChange={(e) => onChange(e.target.value)}
  />
);

const MediaUrlEditor: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => (
  <div className="gw-field__media">
    <input
      type="url"
      className="gw-field__input"
      value={value}
      placeholder="https://media.example.com/…"
      onChange={(e) => onChange(e.target.value)}
    />
    {value && <img src={value} alt="" className="gw-field__media-preview" />}
  </div>
);

const NumberEditor: React.FC<{ value: number; onChange: (v: number) => void; step: string }> = ({ value, onChange, step }) => (
  <input
    type="number"
    className="gw-field__input"
    value={Number.isFinite(value) ? value : 0}
    step={step}
    onChange={(e) => {
      const n = Number(e.target.value);
      onChange(Number.isFinite(n) ? n : 0);
    }}
  />
);

const BooleanEditor: React.FC<{ value: boolean; onChange: (v: boolean) => void }> = ({ value, onChange }) => (
  <input
    type="checkbox"
    className="gw-field__checkbox"
    checked={value}
    onChange={(e) => onChange(e.target.checked)}
  />
);

const SelectEditor: React.FC<{ value: string; options: ReadonlyArray<unknown>; onChange: (v: unknown) => void }> = ({ value, options, onChange }) => (
  <select
    className="gw-field__select"
    value={value}
    onChange={(e) => onChange(e.target.value)}
  >
    {options.map((opt, i) => {
      const s = typeof opt === 'string' ? opt : String(opt);
      return <option key={`${s}-${i}`} value={s}>{s}</option>;
    })}
  </select>
);

const ObjectEditor: React.FC<{
  value: Record<string, unknown> | null;
  schema: SchemaNode;
  onChange: (v: Record<string, unknown>) => void;
  renderers: FieldRendererMap | undefined;
}> = ({ value, schema, onChange, renderers }) => {
  const v = value ?? {};
  const props = schema.properties ?? {};
  return (
    <fieldset className="gw-field__object">
      {Object.entries(props).map(([key, child]) => (
        <Field
          key={key}
          pointer={`/${escapePointer(key)}`}
          schema={child}
          value={v[key]}
          onChange={(next) => onChange({ ...v, [key]: next })}
          renderers={renderers}
        />
      ))}
    </fieldset>
  );
};

const ArrayEditor: React.FC<{
  value: unknown[];
  schema: SchemaNode;
  onChange: (v: unknown[]) => void;
  renderers: FieldRendererMap | undefined;
}> = ({ value, schema, onChange, renderers }) => {
  const itemsSchema = schema.items ?? { type: 'string' };
  return (
    <div className="gw-field__array">
      {value.map((item, i) => (
        <div className="gw-field__array-item" key={i}>
          <Field
            pointer={`/${i}`}
            schema={itemsSchema}
            value={item}
            onChange={(next) => {
              const copy = [...value];
              copy[i] = next;
              onChange(copy);
            }}
            renderers={renderers}
          />
          <button
            type="button"
            className="gw-field__array-remove"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="gw-field__array-add"
        onClick={() => onChange([...value, buildDefault(itemsSchema)])}
      >
        Add
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Helpers (re-exported for tests)
// ---------------------------------------------------------------------------

export function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
export function asNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
export function asBool(v: unknown): boolean {
  return v === true;
}

function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function labelFromPointer(pointer: string): string {
  if (pointer === '') return '(root)';
  const parts = pointer.split('/').filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? pointer;
}

// Re-export walkFields for the SchemaEditor consumer that needs the flat form.
export { walkFields };
