/**
 * Properties panel — right rail. Schema-driven structured field editor for
 * the selected block. Inline-editable fields (those rendered via data-field
 * + data-edit) appear as read-only labels here; structured fields (image
 * picker, color, padding, enum) get inputs.
 *
 * v1 covers: string, number, integer, boolean, string-with-enum.
 * Image picker is a stub (shows the bound id; full picker is Phase 2).
 * Object/array editing is Phase 2.
 */

import { useCallback, useMemo, useState } from 'react';
import { ArrowUpIcon, ArrowDownIcon, TrashIcon, BookmarkSquareIcon } from '@heroicons/react/24/outline';
import { Button, Card, Input, Select } from '@/components/ui';
import { lookup } from '../../../lib/canvas-render/jsonpath.js';
import type { BlockSelection } from './canvas-service.js';

interface PropertiesPanelProps {
  selection: BlockSelection | null;
  /** Called when a structured field value changes. */
  onUpdateField: (fieldPath: string, newValue: unknown) => void;
  /** Move/delete affordances. */
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  /** Open the "Save as preset" modal for the selected block. */
  onSaveAsPreset: () => void;
  disabled?: boolean;
}

interface FieldDescriptor {
  path: string;
  title: string;
  schema: Record<string, unknown>;
}

/**
 * Walk the schema and produce a flat list of leaf fields. v1 only descends
 * into top-level object properties; nested objects are surfaced as read-only
 * "(object)" placeholders. Phase 2 will recurse with grouped sections.
 */
function describeFields(rootSchema: Record<string, unknown>): FieldDescriptor[] {
  if (typeof rootSchema !== 'object' || rootSchema === null) return [];
  const props = (rootSchema as { properties?: Record<string, unknown> }).properties;
  if (!props) return [];
  const out: FieldDescriptor[] = [];
  for (const [name, schemaUnknown] of Object.entries(props)) {
    if (typeof schemaUnknown !== 'object' || schemaUnknown === null) continue;
    const schema = schemaUnknown as Record<string, unknown>;
    const title = (schema.title as string | undefined) ?? name;
    out.push({ path: name, title, schema });
  }
  return out;
}

export function PropertiesPanel({
  selection, onUpdateField, canMoveUp, canMoveDown, onMoveUp, onMoveDown, onDelete, onSaveAsPreset, disabled,
}: PropertiesPanelProps) {
  const fields = useMemo(
    () => (selection ? describeFields(selection.blockDefSchema) : []),
    [selection],
  );

  return (
    <Card>
      <div className="p-3 space-y-3">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-sm font-semibold text-[var(--gray-12)]">Properties</h3>
          {selection && (
            <span className="text-[11px] text-[var(--gray-a8)] font-mono">{selection.blockDefKey}</span>
          )}
        </div>

        {!selection && (
          <p className="px-1 text-xs text-[var(--gray-a8)]">
            Click a block in the canvas to inspect or edit its fields.
          </p>
        )}

        {selection && (
          <>
            <div className="flex items-center gap-1 px-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={onMoveUp}
                disabled={disabled || !canMoveUp}
                aria-label="Move up"
                title="Move up"
              >
                <ArrowUpIcon className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onMoveDown}
                disabled={disabled || !canMoveDown}
                aria-label="Move down"
                title="Move down"
              >
                <ArrowDownIcon className="size-4" />
              </Button>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                onClick={onSaveAsPreset}
                disabled={disabled}
                aria-label="Save as preset"
                title="Save this block (and any bricks) as a reusable preset"
              >
                <BookmarkSquareIcon className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onDelete}
                disabled={disabled}
                color="error"
                aria-label="Delete block"
                title="Delete block"
              >
                <TrashIcon className="size-4" />
              </Button>
            </div>

            {fields.length === 0 && (
              <p className="px-1 text-xs text-[var(--gray-a8)]">
                This block has no editable properties.
              </p>
            )}

            <div className="space-y-3">
              {fields.map((f) => (
                <FieldEditor
                  key={f.path}
                  field={f}
                  value={lookup(selection.content, f.path)}
                  onChange={(v) => onUpdateField(f.path, v)}
                  disabled={disabled}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function FieldEditor({
  field, value, onChange, disabled,
}: {
  field: FieldDescriptor;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  const [local, setLocal] = useState<string>(() => stringify(value));
  const type = field.schema.type as string | undefined;
  const enumValues = field.schema.enum as ReadonlyArray<string> | undefined;
  const format = field.schema.format as string | undefined;

  // Inline-editable fields are surfaced via the canvas decorator, not here.
  // We mark them read-only with a hint.
  if (format === 'html' || format === 'trusted-html') {
    return (
      <div className="space-y-1 px-1">
        <label className="block text-xs font-medium text-[var(--gray-a9)]">{field.title}</label>
        <p className="text-[11px] text-[var(--gray-a8)] italic">
          Edit in the canvas — click the rendered text to type inline.
        </p>
      </div>
    );
  }

  if (format === 'site-media-id') {
    return (
      <div className="space-y-1 px-1">
        <label className="block text-xs font-medium text-[var(--gray-a9)]">{field.title}</label>
        <Input
          value={local}
          disabled={disabled}
          placeholder="Media id"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLocal(e.target.value)}
          onBlur={() => onChange(local)}
        />
        <p className="text-[11px] text-[var(--gray-a8)]">Media picker UI ships in Phase 2.</p>
      </div>
    );
  }

  if (format === 'css-color') {
    const colorValue = typeof value === 'string' && value.length > 0 ? value : '#000000';
    return (
      <div className="space-y-1 px-1">
        <label className="block text-xs font-medium text-[var(--gray-a9)]">{field.title}</label>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={normalizeColor(colorValue)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 w-12 rounded border border-[var(--gray-a5)] cursor-pointer disabled:cursor-not-allowed"
          />
          <Input
            value={local}
            disabled={disabled}
            placeholder="#000000 or rgba(...)"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLocal(e.target.value)}
            onBlur={() => onChange(local)}
          />
        </div>
      </div>
    );
  }

  if (format === 'css-spacing' || format === 'css-padding' || format === 'css-margin') {
    const presets = ['none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'];
    return (
      <div className="space-y-1 px-1">
        <label className="block text-xs font-medium text-[var(--gray-a9)]">{field.title}</label>
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              disabled={disabled}
              className={`px-2 py-1 text-xs rounded-md border transition-colors disabled:opacity-50 ${
                value === p
                  ? 'bg-[var(--accent-a4)] border-[var(--accent-9)] text-[var(--accent-12)]'
                  : 'border-[var(--gray-a5)] hover:bg-[var(--gray-a3)] text-[var(--gray-12)]'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (enumValues && type === 'string') {
    return (
      <div className="space-y-1 px-1">
        <label className="block text-xs font-medium text-[var(--gray-a9)]">{field.title}</label>
        <Select
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
          data={enumValues.map((v) => ({ value: v, label: v }))}
        />
      </div>
    );
  }

  if (type === 'boolean') {
    return (
      <label className="flex items-center gap-2 px-1 text-sm text-[var(--gray-12)]">
        <input
          type="checkbox"
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{field.title}</span>
      </label>
    );
  }

  if (type === 'number' || type === 'integer') {
    return (
      <div className="space-y-1 px-1">
        <label className="block text-xs font-medium text-[var(--gray-a9)]">{field.title}</label>
        <Input
          type="number"
          value={local}
          disabled={disabled}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLocal(e.target.value)}
          onBlur={() => {
            const n = Number(local);
            if (Number.isFinite(n)) onChange(type === 'integer' ? Math.trunc(n) : n);
          }}
        />
      </div>
    );
  }

  if (type === 'object') {
    return (
      <div className="space-y-1 px-1">
        <label className="block text-xs font-medium text-[var(--gray-a9)]">{field.title}</label>
        <p className="text-[11px] text-[var(--gray-a8)] italic">
          Object editing ships in Phase 2; for now, edit inline.
        </p>
      </div>
    );
  }

  // Default: string input.
  return (
    <div className="space-y-1 px-1">
      <label className="block text-xs font-medium text-[var(--gray-a9)]">{field.title}</label>
      <Input
        value={local}
        disabled={disabled}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLocal(e.target.value)}
        onBlur={() => onChange(local)}
      />
    </div>
  );
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * Normalise a color value for the native <input type="color">. The element
 * only accepts `#rrggbb` — strips alpha, converts named colors, falls back
 * to black on parse failure.
 */
function normalizeColor(input: string): string {
  const trimmed = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{8}$/.test(trimmed)) return trimmed.slice(0, 7).toLowerCase();
  // rgba/named — return black; the text input next to the color picker
  // still shows the original value so the user isn't surprised.
  return '#000000';
}
