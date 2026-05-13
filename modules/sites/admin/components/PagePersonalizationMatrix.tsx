/**
 * Page personalization matrix — overview of every personalizable field on
 * a page and its per-persona variants. Rendered as a tab inside the
 * page editor (see pages/page-editor.tsx).
 *
 * Per spec-aaif-theme-deliverable §5.2.2: the matrix exists primarily for
 * array fields where variants encode reordering / show-hide. For scalar
 * fields the matrix degrades to a simple "default value vs. persona X
 * value" comparison.
 *
 * Layout:
 *   - Top: pick a persona to inspect. The matrix highlights cells that
 *     are overridden for that persona.
 *   - Body: one section per personalizable field. Default value on the
 *     left; per-persona variant on the right. "Edit" opens the
 *     VariantEditor side panel scoped to that field + persona.
 *
 * Editing is delegated to VariantEditor; this component never POSTs.
 */

import { useMemo, useState } from 'react';
import { Badge, Button, Card, Select } from '@/components/ui';
import { PencilSquareIcon } from '@heroicons/react/24/outline';
import { walkFields, type SchemaNode } from '../schema-editor/walk-schema';
import { fieldPathToJsonPointer, jsonPointerToFieldPath } from '../lib/field-path';
import type { PageVariant } from '../services/pageVariantsService';
import type { Persona } from '../services/personasService';
import { getAtPointer } from '../schema-editor/walk-schema';

export interface PagePersonalizationMatrixProps {
  schema: SchemaNode;
  /** The page's default content — what every persona inherits unless overridden. */
  defaultContent: Record<string, unknown>;
  personas: Persona[];
  variants: PageVariant[];
  /** Fired when the user clicks "Edit" — host opens the VariantEditor. */
  onEditField: (pointer: string) => void;
}

interface PersonalizableField {
  pointer: string;
  fieldPath: string;
  label: string;
  isArray: boolean;
}

export function PagePersonalizationMatrix({
  schema,
  defaultContent,
  personas,
  variants,
  onEditField,
}: PagePersonalizationMatrixProps) {
  const fields = useMemo(() => collectPersonalizableFields(schema), [schema]);
  const [focusPersonaId, setFocusPersonaId] = useState<string | 'all'>('all');

  if (fields.length === 0) {
    return (
      <Card className="p-6 text-center border-dashed">
        <p className="text-sm text-(--gray-9)">
          This page's content schema has no fields marked <code>x-gatewaze-personalize</code>.
          Mark fields in the schema to enable per-persona variants.
        </p>
      </Card>
    );
  }

  const variantsByField = groupVariantsByField(variants);

  return (
    <div className="space-y-4">
      <Card className="p-3 flex items-center gap-3 flex-wrap">
        <span className="text-xs font-medium">Show variants for</span>
        <Select
          value={focusPersonaId}
          onChange={(e) => setFocusPersonaId(e.target.value)}
        >
          <option value="all">All personas</option>
          {personas.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </Select>
        <span className="text-xs text-(--gray-9)">
          {fields.length} personalizable field{fields.length === 1 ? '' : 's'} ·{' '}
          {variants.length} active variant{variants.length === 1 ? '' : 's'}
        </span>
      </Card>

      {fields.map((field) => (
        <FieldRow
          key={field.fieldPath}
          field={field}
          defaultContent={defaultContent}
          personas={personas}
          variants={variantsByField.get(field.fieldPath) ?? []}
          focusPersonaId={focusPersonaId}
          onEdit={() => onEditField(field.pointer)}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function FieldRow({
  field,
  defaultContent,
  personas,
  variants,
  focusPersonaId,
  onEdit,
}: {
  field: PersonalizableField;
  defaultContent: Record<string, unknown>;
  personas: Persona[];
  variants: PageVariant[];
  focusPersonaId: string | 'all';
  onEdit: () => void;
}) {
  const defaultValue = getAtPointer(defaultContent, field.pointer);
  const personaById = new Map(personas.map((p) => [p.id, p]));

  // Filter to focused persona when one is selected.
  const visibleVariants =
    focusPersonaId === 'all' ? variants : variants.filter((v) => v.persona_id === focusPersonaId);

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h4 className="font-semibold">{field.label}</h4>
          <code className="text-xs text-(--gray-9)">{field.fieldPath}</code>
          {field.isArray && <Badge variant="soft" color="blue" size="1" className="ml-2">array</Badge>}
        </div>
        <Button variant="ghost" size="2" onClick={onEdit}>
          <PencilSquareIcon className="w-4 h-4" /> Edit variants
        </Button>
      </div>

      <div className="grid grid-cols-12 gap-3 text-sm">
        <div className="col-span-4">
          <div className="text-xs font-medium text-(--gray-11) mb-1">Default</div>
          <ValuePreview value={defaultValue} isArray={field.isArray} />
        </div>
        <div className="col-span-8">
          <div className="text-xs font-medium text-(--gray-11) mb-1">Variants</div>
          {visibleVariants.length === 0 ? (
            <span className="text-xs text-(--gray-9) italic">No variants — default applies for all visitors.</span>
          ) : (
            <ul className="space-y-1">
              {visibleVariants.map((v) => {
                const persona = v.persona_id ? personaById.get(v.persona_id) : null;
                return (
                  <li key={v.id} className="flex items-start gap-2">
                    <Badge variant="soft" color={persona ? 'accent' : 'gray'} size="1">
                      {persona?.label ?? matchContextSummary(v.match_context)}
                    </Badge>
                    <div className="flex-1">
                      <ValuePreview value={v.value} isArray={field.isArray} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

function ValuePreview({ value, isArray }: { value: unknown; isArray: boolean }) {
  if (value === undefined || value === null) {
    return <span className="text-xs text-(--gray-9) italic">(empty)</span>;
  }
  if (isArray && Array.isArray(value)) {
    return (
      <ol className="text-xs space-y-0.5 list-decimal list-inside">
        {value.slice(0, 5).map((item, i) => (
          <li key={i} className="truncate">{summariseItem(item)}</li>
        ))}
        {value.length > 5 && <li className="text-(--gray-9)">+ {value.length - 5} more</li>}
      </ol>
    );
  }
  if (typeof value === 'string') {
    return <span className="text-xs">{value.length > 80 ? `${value.slice(0, 80)}…` : value}</span>;
  }
  return <code className="text-xs">{JSON.stringify(value).slice(0, 80)}</code>;
}

function summariseItem(item: unknown): string {
  if (item === null || typeof item !== 'object') return String(item);
  const obj = item as Record<string, unknown>;
  for (const key of ['title', 'name', 'label', 'heading']) {
    if (typeof obj[key] === 'string') return obj[key] as string;
  }
  return JSON.stringify(obj).slice(0, 60);
}

function matchContextSummary(ctx: Record<string, unknown>): string {
  const entries = Object.entries(ctx);
  if (entries.length === 0) return '(no rules)';
  return entries
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}∈[${v.slice(0, 2).join(',')}${v.length > 2 ? '…' : ''}]`;
      return `${k}=${JSON.stringify(v)}`;
    })
    .join(' & ');
}

// ---------------------------------------------------------------------------
// Schema walking
// ---------------------------------------------------------------------------

function collectPersonalizableFields(schema: SchemaNode): PersonalizableField[] {
  const flat = walkFields(schema);
  const out: PersonalizableField[] = [];
  for (const desc of flat) {
    if (!desc.personalizable) continue;
    out.push({
      pointer: desc.pointer,
      fieldPath: jsonPointerToFieldPath(desc.pointer),
      label: desc.label,
      isArray: desc.kind === 'array',
    });
  }
  return out;
}

function groupVariantsByField(variants: PageVariant[]): Map<string, PageVariant[]> {
  const m = new Map<string, PageVariant[]>();
  for (const v of variants) {
    const arr = m.get(v.field_path) ?? [];
    arr.push(v);
    m.set(v.field_path, arr);
  }
  return m;
}

// Re-export the converter so the host can build pointers when wiring onEdit.
export { fieldPathToJsonPointer };
