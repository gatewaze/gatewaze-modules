/**
 * VariantEditor — modal side-panel that opens when the user clicks
 * "Personalize" on a field in the SchemaEditor.
 *
 * Per spec-aaif-theme-deliverable §5.2 and the user-confirmed Option C
 * direction (inline per-field + matrix tab for arrays).
 *
 * Lifecycle:
 *   1. User clicks "Personalize" on a field marked x-gatewaze-personalize.
 *   2. The page editor records the JSON pointer (e.g. `/heroTitle`) and
 *      opens this component.
 *   3. We fetch the site's personas + the page's variants on mount,
 *      filter variants to the requested field_path, and render one row
 *      per existing variant + an "Add variant" action.
 *   4. Each variant row exposes: persona dropdown (or custom match_context),
 *      value editor (driven by the field's JSON Schema subnode using the
 *      same renderers as the main editor), priority slider, save + delete.
 *
 * The value editor reuses <Field> from schema-editor so any custom
 * renderers (rich text, media picker) the host admin app injects into
 * SchemaEditor are honoured here too.
 */

import { useEffect, useState } from 'react';
import { Badge, Button, Card, Modal, Select } from '@/components/ui';
import { PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Field, type FieldRendererMap } from '../schema-editor/Field';
import { type SchemaNode, buildDefault } from '../schema-editor/walk-schema';
import { PageVariantsService, type PageVariant } from '../services/pageVariantsService';
import { PersonasService, type Persona } from '../services/personasService';

export interface VariantEditorProps {
  /** Page being edited. */
  pageId: string;
  /** Site that owns the page — used to load the personas list. */
  siteId: string;
  /**
   * Field-path key under which variants are stored. Computed by the caller
   * so VariantEditor stays agnostic to schema-mode vs blocks-mode:
   *   - schema-mode: `heroTitle`, `hero.title`, `contentBlocks[2].title`
   *   - blocks-mode: `<page-block-id>.<propName>`
   */
  fieldPath: string;
  /** Optional human-friendly label for the modal header. Falls back to fieldPath. */
  fieldLabel?: string;
  /** Schema for the field — drives the value editor. Pass null to fall back to raw JSON. */
  fieldSchema: SchemaNode | null;
  /** Renderer overrides forwarded to the value-editor Field (e.g. rich text). */
  renderers?: FieldRendererMap;
  onClose: () => void;
}

interface VariantDraft {
  /** Local draft state for a single variant row. `id` is null for unsaved variants. */
  id: string | null;
  persona_id: string | null;
  /** When persona_id is set we treat the variant as persona-targeted; match_context
   *  is `{ persona: '<persona-name>' }` server-side. When null, the editor exposes
   *  a free-form match_context input. */
  customMatchContext: Record<string, unknown>;
  value: unknown;
  priority: number;
  dirty: boolean;
}

export function VariantEditor({ pageId, siteId, fieldPath, fieldLabel, fieldSchema, renderers, onClose }: VariantEditorProps) {
  const [loading, setLoading] = useState(true);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [drafts, setDrafts] = useState<VariantDraft[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const [personasRes, variantsRes] = await Promise.all([
        PersonasService.list(siteId),
        PageVariantsService.list(pageId),
      ]);
      if (cancelled) return;
      if (personasRes.error) toast.error(`Personas: ${personasRes.error}`);
      if (variantsRes.error) toast.error(`Variants: ${variantsRes.error}`);
      setPersonas(personasRes.personas);
      setDrafts(variantsRes.variants.filter((v) => v.field_path === fieldPath).map(variantToDraft));
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [siteId, pageId, fieldPath]);

  function addDraft() {
    const defaultValue = fieldSchema ? buildDefault(fieldSchema) : '';
    setDrafts((prev) => [
      ...prev,
      {
        id: null,
        persona_id: personas[0]?.id ?? null,
        customMatchContext: {},
        value: defaultValue,
        priority: 100,
        dirty: true,
      },
    ]);
  }

  function updateDraft(idx: number, patch: Partial<VariantDraft>) {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch, dirty: true } : d)));
  }

  async function saveDraft(idx: number) {
    const draft = drafts[idx]!;
    const matchContext = buildMatchContext(draft, personas);
    if (!matchContext) {
      toast.error('A persona or at least one match-context axis is required.');
      return;
    }
    if (draft.id === null) {
      const res = await PageVariantsService.create({
        pageId,
        field_path: fieldPath,
        match_context: matchContext,
        value: draft.value,
        priority: draft.priority,
        persona_id: draft.persona_id,
      });
      if (res.error || !res.variant) {
        toast.error(`Save failed: ${res.error}`);
        return;
      }
      setDrafts((prev) => prev.map((d, i) => (i === idx ? variantToDraft(res.variant!) : d)));
      toast.success('Variant created');
      return;
    }
    const res = await PageVariantsService.update({
      pageId,
      variantId: draft.id,
      patch: {
        match_context: matchContext,
        value: draft.value,
        priority: draft.priority,
        persona_id: draft.persona_id,
      },
    });
    if (res.error || !res.variant) {
      toast.error(`Save failed: ${res.error}`);
      return;
    }
    setDrafts((prev) => prev.map((d, i) => (i === idx ? variantToDraft(res.variant!) : d)));
    toast.success('Variant saved');
  }

  async function removeDraft(idx: number) {
    const draft = drafts[idx]!;
    if (draft.id === null) {
      setDrafts((prev) => prev.filter((_, i) => i !== idx));
      return;
    }
    const res = await PageVariantsService.delete(pageId, draft.id);
    if (res.error) {
      toast.error(`Delete failed: ${res.error}`);
      return;
    }
    setDrafts((prev) => prev.filter((_, i) => i !== idx));
    toast.success('Variant deleted');
  }

  return (
    <Modal isOpen onClose={onClose} size="xl" title={`Personalize: ${fieldLabel ?? fieldPath}`}>
      {loading ? (
        <LoadingSpinner />
      ) : (
        <div className="space-y-4">
          <header className="text-sm text-(--gray-9)">
            <p>
              Each row defines a variant value that replaces the default when the request matches.
              Variants are tried by specificity (more match-context axes wins), then priority (lower
              first), then most-recent edit.
            </p>
          </header>

          {!fieldSchema && (
            <Card className="p-3 border-dashed">
              <p className="text-sm text-(--orange-9)">
                Couldn't resolve a schema for <code>{fieldPath}</code>. The value editor falls back
                to raw JSON.
              </p>
            </Card>
          )}

          {drafts.length === 0 ? (
            <Card className="p-6 text-center border-dashed">
              <p className="text-sm text-(--gray-9) mb-3">
                No variants yet. The default value will always be served for this field.
              </p>
              <Button variant="solid" onClick={addDraft}>
                <PlusIcon className="w-4 h-4" /> Add variant
              </Button>
            </Card>
          ) : (
            <>
              <div className="space-y-3">
                {drafts.map((d, idx) => (
                  <VariantRow
                    key={d.id ?? `new-${idx}`}
                    draft={d}
                    personas={personas}
                    fieldSchema={fieldSchema}
                    renderers={renderers}
                    onChange={(patch) => updateDraft(idx, patch)}
                    onSave={() => void saveDraft(idx)}
                    onRemove={() => void removeDraft(idx)}
                  />
                ))}
              </div>
              <div>
                <Button variant="ghost" onClick={addDraft}>
                  <PlusIcon className="w-4 h-4" /> Add another variant
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Variant row — one card per variant
// ---------------------------------------------------------------------------

function VariantRow({
  draft,
  personas,
  fieldSchema,
  renderers,
  onChange,
  onSave,
  onRemove,
}: {
  draft: VariantDraft;
  personas: Persona[];
  fieldSchema: SchemaNode | null;
  renderers: FieldRendererMap | undefined;
  onChange: (patch: Partial<VariantDraft>) => void;
  onSave: () => void;
  onRemove: () => void;
}) {
  const personaMode = draft.persona_id !== null;

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-(--gray-11)">Target</span>
          <Select
            value={personaMode ? draft.persona_id ?? '' : '__custom'}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__custom') {
                onChange({ persona_id: null });
              } else {
                onChange({ persona_id: v });
              }
            }}
          >
            {personas.map((p) => (
              <option key={p.id} value={p.id}>{p.label} <span>{p.is_default ? '(default)' : ''}</span></option>
            ))}
            <option value="__custom">Custom match context…</option>
          </Select>
          {draft.dirty && <Badge variant="soft" color="orange" size="1">unsaved</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-(--gray-11)" title="Lower priority is tried first">
            Priority
          </label>
          <input
            type="number"
            value={draft.priority}
            min={0}
            max={10000}
            className="w-20 px-2 py-1 text-sm border rounded"
            onChange={(e) => onChange({ priority: Number(e.target.value) || 0 })}
          />
          <Button variant="ghost" size="2" onClick={onRemove} title="Delete variant">
            <TrashIcon className="w-4 h-4 text-(--red-9)" />
          </Button>
        </div>
      </div>

      {!personaMode && (
        <div className="mb-3">
          <label className="block text-xs font-medium mb-1">Match context (JSON)</label>
          <textarea
            className="w-full px-2 py-1 text-sm font-mono border rounded"
            rows={3}
            value={JSON.stringify(draft.customMatchContext, null, 2)}
            onChange={(e) => {
              try {
                const parsed = JSON.parse(e.target.value);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  onChange({ customMatchContext: parsed as Record<string, unknown> });
                }
              } catch {
                // ignore — let the user keep typing; save will validate
              }
            }}
          />
          <p className="text-xs text-(--gray-9) mt-1">
            e.g. <code>{`{ "utm.campaign": "spring-2026" }`}</code> or
            <code> {`{ "geo.country": ["GB", "IE"] }`}</code> (array = OR).
          </p>
        </div>
      )}

      <div>
        <label className="block text-xs font-medium mb-1">Value</label>
        {fieldSchema ? (
          <Field
            pointer=""
            schema={fieldSchema}
            value={draft.value}
            onChange={(v) => onChange({ value: v })}
            renderers={renderers}
          />
        ) : (
          <textarea
            className="w-full px-2 py-1 text-sm font-mono border rounded"
            rows={5}
            value={JSON.stringify(draft.value, null, 2)}
            onChange={(e) => {
              try {
                onChange({ value: JSON.parse(e.target.value) });
              } catch {
                // keep typing
              }
            }}
          />
        )}
      </div>

      <div className="mt-3 flex justify-end">
        <Button variant="solid" disabled={!draft.dirty} onClick={onSave}>
          {draft.id === null ? 'Create' : 'Save'}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function variantToDraft(v: PageVariant): VariantDraft {
  const customMatchContext: Record<string, unknown> = {};
  // If a persona is bound we only show its label; the match_context the
  // server stores is `{ persona: <name> }` — we don't surface it.
  if (v.persona_id === null) {
    Object.assign(customMatchContext, v.match_context);
  }
  return {
    id: v.id,
    persona_id: v.persona_id,
    customMatchContext,
    value: v.value,
    priority: v.priority,
    dirty: false,
  };
}

function buildMatchContext(draft: VariantDraft, personas: Persona[]): Record<string, unknown> | null {
  if (draft.persona_id !== null) {
    const persona = personas.find((p) => p.id === draft.persona_id);
    if (!persona) return null;
    return { persona: persona.name };
  }
  if (Object.keys(draft.customMatchContext).length === 0) return null;
  return draft.customMatchContext;
}
