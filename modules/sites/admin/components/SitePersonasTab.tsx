/**
 * Site personas tab — manage the named segments (Developer, Enterprise, …)
 * that drive page personalisation for this site.
 *
 * Per spec-aaif-theme-deliverable §5.2.
 *
 * Layout:
 *   - Left column (2/3): personas list. Click "Add" to create. Click a
 *     row to edit. Drag handles reorder priority (lower = checked first).
 *     The default persona is marked with a chip.
 *   - Right column (1/3): "Test rules" sidebar. Enter a sample
 *     RenderContext (URL param / UTM / etc.) and see which persona
 *     resolves and which condition matched. Calls the test-resolve
 *     endpoint so the admin behaves identically to the runtime.
 *
 * Create/edit opens a modal with the persona form + the conditions editor.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Input,
  Modal,
  Select,
  Textarea,
} from '@/components/ui';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import {
  PlusIcon,
  PencilSquareIcon,
  TrashIcon,
  CheckCircleIcon,
  XCircleIcon,
  BeakerIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import type { SiteRow } from '../../types';
import {
  PersonasService,
  type Persona,
  type PersonaCondition,
  type PersonaAxis,
  type PersonaOperator,
  PERSONA_AXES,
  PERSONA_OPERATORS,
} from '../services/personasService';

// ---------------------------------------------------------------------------
// SitePersonasTab — top-level
// ---------------------------------------------------------------------------

export function SitePersonasTab({ site }: { site: SiteRow }) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Persona | 'new' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Persona | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    setLoading(true);
    const { personas, error } = await PersonasService.list(site.id);
    if (error) toast.error(`Failed to load personas: ${error}`);
    setPersonas(personas);
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id]);

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error } = await PersonasService.delete(site.id, deleteTarget.id);
    setDeleting(false);
    if (error) {
      toast.error(`Delete failed: ${error}`);
      return;
    }
    toast.success(`Deleted "${deleteTarget.label}"`);
    setPersonas((prev) => prev.filter((p) => p.id !== deleteTarget.id));
    setDeleteTarget(null);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* LEFT: list */}
      <div className="lg:col-span-2">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">Personas</h2>
            <p className="text-sm text-(--gray-9)">
              Named segments with resolution rules. The runtime resolves each request to one persona,
              then serves the right variant of personalised fields.
            </p>
          </div>
          <Button color="primary" onClick={() => setEditing('new')}>
            <PlusIcon className="w-4 h-4" /> Add persona
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <LoadingSpinner />
          </div>
        ) : personas.length === 0 ? (
          <EmptyState onAdd={() => setEditing('new')} />
        ) : (
          <div className="space-y-2">
            {personas.map((persona) => (
              <PersonaRow
                key={persona.id}
                persona={persona}
                onEdit={() => setEditing(persona)}
                onDelete={() => setDeleteTarget(persona)}
              />
            ))}
          </div>
        )}
      </div>

      {/* RIGHT: test-resolve */}
      <div className="lg:col-span-1">
        <TestResolveSidebar siteId={site.id} personas={personas} />
      </div>

      {/* MODAL */}
      {editing && (
        <PersonaEditorModal
          siteId={site.id}
          persona={editing === 'new' ? null : editing}
          existingNames={personas.filter((p) => editing === 'new' || p.id !== editing.id).map((p) => p.name)}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}

      <ConfirmModal
        isOpen={deleteTarget !== null}
        onClose={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={() => { void confirmDelete(); }}
        title={`Delete "${deleteTarget?.label ?? ''}"?`}
        message="This can't be undone. Page variants targeting this persona will be left in place but their persona link will be cleared."
        confirmText={deleting ? 'Deleting…' : 'Delete persona'}
        confirmColor="red"
        isProcessing={deleting}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Persona row
// ---------------------------------------------------------------------------

function PersonaRow({
  persona,
  onEdit,
  onDelete,
}: {
  persona: Persona;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className="p-4 hover:border-(--accent-7) transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-medium text-base">{persona.label}</h3>
            <Badge variant="soft" color="gray" size="1">{persona.name}</Badge>
            {persona.is_default && (
              <Badge variant="soft" color="blue" size="1">default</Badge>
            )}
            <Badge variant="soft" color="gray" size="1">priority {persona.priority}</Badge>
          </div>
          {persona.description && (
            <p className="text-sm text-(--gray-10) mt-1">{persona.description}</p>
          )}
          <p className="text-xs text-(--gray-9) mt-2">
            {persona.conditions.length === 0
              ? 'No resolution rules — only matched when this is the default persona'
              : `${persona.conditions.length} rule${persona.conditions.length === 1 ? '' : 's'}: ${persona.conditions
                  .map((c) => formatConditionShort(c))
                  .slice(0, 3)
                  .join(', ')}${persona.conditions.length > 3 ? `, +${persona.conditions.length - 3}` : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="2" onClick={onEdit} title="Edit">
            <PencilSquareIcon className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="2" onClick={onDelete} title="Delete">
            <TrashIcon className="w-4 h-4 text-(--red-9)" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

function formatConditionShort(c: PersonaCondition): string {
  if (c.axis === '*self_select') return 'self-select';
  if (c.operator === 'exists') return `${c.axis} present`;
  if (c.operator === 'in' && Array.isArray(c.value)) {
    const arr = c.value as readonly string[];
    return `${c.axis} in [${arr.slice(0, 2).join(', ')}${arr.length > 2 ? `, +${arr.length - 2}` : ''}]`;
  }
  const op = c.operator === 'not_eq' ? '≠' : '=';
  return `${c.axis} ${op} ${JSON.stringify(c.value)}`;
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <Card className="p-12 text-center border-dashed">
      <div className="mx-auto w-12 h-12 bg-(--gray-3) rounded-full flex items-center justify-center mb-4">
        <PlusIcon className="w-6 h-6 text-(--gray-9)" />
      </div>
      <h3 className="font-medium mb-1">No personas yet</h3>
      <p className="text-sm text-(--gray-9) mb-4 max-w-sm mx-auto">
        Add a persona to start personalising page content. Each persona has rules (URL params, UTM tags, geo, …)
        that determine which visitors are classified as that persona.
      </p>
      <Button color="primary" onClick={onAdd}>
        <PlusIcon className="w-4 h-4" /> Add your first persona
      </Button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Editor modal
// ---------------------------------------------------------------------------

interface PersonaFormState {
  name: string;
  label: string;
  description: string;
  is_default: boolean;
  priority: number;
  conditions: PersonaCondition[];
}

function PersonaEditorModal({
  siteId,
  persona,
  existingNames,
  onClose,
  onSaved,
}: {
  siteId: string;
  persona: Persona | null;
  existingNames: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isCreate = persona === null;
  const [form, setForm] = useState<PersonaFormState>(() => ({
    name: persona?.name ?? '',
    label: persona?.label ?? '',
    description: persona?.description ?? '',
    is_default: persona?.is_default ?? false,
    priority: persona?.priority ?? 100,
    conditions: persona?.conditions ?? [],
  }));
  const [saving, setSaving] = useState(false);

  const nameError = useMemo(() => {
    if (!form.name) return 'required';
    if (!/^[a-z][a-z0-9-]*$/.test(form.name)) return 'lowercase letters, numbers, dashes — must start with a letter';
    if (existingNames.includes(form.name)) return 'already in use on this site';
    return null;
  }, [form.name, existingNames]);

  const labelError = useMemo(() => (!form.label.trim() ? 'required' : null), [form.label]);

  async function handleSave() {
    if (nameError || labelError) {
      toast.error('Fix the form errors before saving');
      return;
    }
    setSaving(true);
    try {
      if (isCreate) {
        const { error } = await PersonasService.create({
          siteId,
          name: form.name,
          label: form.label,
          description: form.description.trim() || null,
          is_default: form.is_default,
          priority: form.priority,
          conditions: form.conditions,
        });
        if (error) {
          toast.error(`Create failed: ${error}`);
          return;
        }
        toast.success(`Created "${form.label}"`);
      } else {
        const { error } = await PersonasService.update({
          siteId,
          personaId: persona!.id,
          patch: {
            name: form.name,
            label: form.label,
            description: form.description.trim() || null,
            is_default: form.is_default,
            priority: form.priority,
            conditions: form.conditions,
          },
        });
        if (error) {
          toast.error(`Update failed: ${error}`);
          return;
        }
        toast.success(`Updated "${form.label}"`);
      }
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={isCreate ? 'Add persona' : `Edit "${persona!.label}"`} size="lg">
      <div className="space-y-5">
        {/* Identity */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Label</label>
            <Input
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="Enterprise buyer"
              error={labelError ?? undefined}
            />
            <p className="text-xs text-(--gray-9) mt-1">Display name shown in lists + editor UI.</p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Name (slug)</label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
              placeholder="enterprise"
              disabled={!isCreate}
              error={nameError ?? undefined}
            />
            <p className="text-xs text-(--gray-9) mt-1">
              {isCreate
                ? 'Used in URLs, cookies, variant match_context. Lowercase + dashes only.'
                : 'Name is immutable post-create — variants reference it.'}
            </p>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Description (optional)</label>
          <Textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Who this persona represents and how variants should target them."
            rows={2}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Priority</label>
            <Input
              type="number"
              min={0}
              max={10000}
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: Number(e.target.value) || 0 })}
            />
            <p className="text-xs text-(--gray-9) mt-1">
              Lower = checked first. Use 0–10 for highly-specific personas, 100+ for catch-alls.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Default persona</label>
            <div className="flex items-center gap-2 h-9">
              <input
                type="checkbox"
                id="is-default"
                checked={form.is_default}
                onChange={(e) => setForm({ ...form, is_default: e.target.checked })}
                className="w-4 h-4"
              />
              <label htmlFor="is-default" className="text-sm">
                Match when no rule fires
              </label>
            </div>
            <p className="text-xs text-(--gray-9) mt-1">
              At most one default per site. Falls back here when nothing else matches.
            </p>
          </div>
        </div>

        {/* Conditions */}
        <ConditionsEditor
          conditions={form.conditions}
          onChange={(next) => setForm({ ...form, conditions: next })}
        />
      </div>

      <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-(--gray-5)">
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button color="primary" onClick={handleSave} disabled={saving || !!nameError || !!labelError}>
          {saving ? 'Saving…' : isCreate ? 'Create persona' : 'Save changes'}
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Conditions editor (axis / operator / value)
// ---------------------------------------------------------------------------

function ConditionsEditor({
  conditions,
  onChange,
}: {
  conditions: PersonaCondition[];
  onChange: (next: PersonaCondition[]) => void;
}) {
  function addCondition() {
    onChange([
      ...conditions,
      { axis: 'persona', operator: 'eq', value: '', persist: false },
    ]);
  }
  function updateCondition(idx: number, patch: Partial<PersonaCondition>) {
    onChange(conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }
  function removeCondition(idx: number) {
    onChange(conditions.filter((_, i) => i !== idx));
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="block text-sm font-medium">Resolution rules</label>
        <Button variant="ghost" size="2" onClick={addCondition}>
          <PlusIcon className="w-4 h-4" /> Add rule
        </Button>
      </div>
      <p className="text-xs text-(--gray-9) mb-3">
        ANY rule that matches selects this persona. Add multiple rules to cover URL params, UTM tags, geo, locale,
        self-select cookie, etc.
      </p>

      {conditions.length === 0 ? (
        <Card className="p-4 text-center border-dashed">
          <p className="text-sm text-(--gray-9)">
            No rules. Add at least one — or mark this persona as the default so it's matched when no rule fires.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {conditions.map((cond, idx) => (
            <ConditionRow
              key={idx}
              condition={cond}
              onChange={(patch) => updateCondition(idx, patch)}
              onRemove={() => removeCondition(idx)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: PersonaCondition;
  onChange: (patch: Partial<PersonaCondition>) => void;
  onRemove: () => void;
}) {
  const isSelfSelect = condition.axis === '*self_select';
  const isBooleanAxis = condition.axis === 'viewer.authenticated';

  function handleAxisChange(axis: PersonaAxis) {
    // Coerce shape when axis flips between scalar/boolean/self-select.
    if (axis === '*self_select') {
      onChange({ axis, operator: 'eq', value: null });
      return;
    }
    if (axis === 'viewer.authenticated') {
      onChange({ axis, operator: 'eq', value: true });
      return;
    }
    // Default scalar string axis.
    if (condition.operator === 'in' && !Array.isArray(condition.value)) {
      onChange({ axis, value: [] });
      return;
    }
    if (condition.operator === 'exists') {
      onChange({ axis, value: null });
      return;
    }
    onChange({ axis, value: typeof condition.value === 'string' ? condition.value : '' });
  }

  function handleOperatorChange(op: PersonaOperator) {
    // Coerce value to the right shape for the new operator.
    if (op === 'in') {
      onChange({ operator: op, value: Array.isArray(condition.value) ? condition.value : [] });
      return;
    }
    if (op === 'exists') {
      onChange({ operator: op, value: null });
      return;
    }
    // eq / not_eq
    if (isBooleanAxis) {
      onChange({ operator: op, value: typeof condition.value === 'boolean' ? condition.value : true });
      return;
    }
    onChange({ operator: op, value: typeof condition.value === 'string' ? condition.value : '' });
  }

  return (
    <Card className="p-3">
      <div className="grid grid-cols-12 gap-2 items-center">
        {/* Axis */}
        <div className="col-span-3">
          <Select
            value={condition.axis}
            onChange={(e) => handleAxisChange(e.target.value as PersonaAxis)}
          >
            {PERSONA_AXES.map((a) => (
              <option key={a} value={a}>
                {a === '*self_select' ? 'Self-select (cookie)' : a}
              </option>
            ))}
          </Select>
        </div>
        {/* Operator (hidden for self-select) */}
        <div className="col-span-2">
          {!isSelfSelect && (
            <Select
              value={condition.operator}
              onChange={(e) => handleOperatorChange(e.target.value as PersonaOperator)}
            >
              {PERSONA_OPERATORS.map((op) => (
                <option key={op} value={op}>{op}</option>
              ))}
            </Select>
          )}
        </div>
        {/* Value (shape depends on operator + axis) */}
        <div className="col-span-5">
          <ConditionValueInput condition={condition} onChange={onChange} />
        </div>
        {/* Persist toggle */}
        <div className="col-span-1 flex items-center justify-center" title="Persist as a cookie when matched">
          <input
            type="checkbox"
            checked={condition.persist}
            onChange={(e) => onChange({ persist: e.target.checked })}
            className="w-4 h-4"
            title="Sticky in cookie"
          />
        </div>
        {/* Remove */}
        <div className="col-span-1 flex items-center justify-end">
          <Button variant="ghost" size="2" onClick={onRemove} title="Remove rule">
            <TrashIcon className="w-4 h-4 text-(--red-9)" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ConditionValueInput({
  condition,
  onChange,
}: {
  condition: PersonaCondition;
  onChange: (patch: Partial<PersonaCondition>) => void;
}) {
  if (condition.axis === '*self_select') {
    return <span className="text-sm text-(--gray-9) italic">(persona selected via cookie)</span>;
  }
  if (condition.operator === 'exists') {
    return <span className="text-sm text-(--gray-9) italic">(any value)</span>;
  }
  if (condition.axis === 'viewer.authenticated') {
    return (
      <Select
        value={String(condition.value)}
        onChange={(e) => onChange({ value: e.target.value === 'true' })}
      >
        <option value="true">true (signed-in)</option>
        <option value="false">false (anonymous)</option>
      </Select>
    );
  }
  if (condition.operator === 'in') {
    const arr = Array.isArray(condition.value) ? (condition.value as readonly string[]) : [];
    return (
      <Input
        value={arr.join(', ')}
        onChange={(e) => {
          const parsed = e.target.value
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          onChange({ value: parsed });
        }}
        placeholder="value-a, value-b, value-c"
      />
    );
  }
  // eq / not_eq with a string axis
  return (
    <Input
      value={typeof condition.value === 'string' ? condition.value : ''}
      onChange={(e) => onChange({ value: e.target.value })}
      placeholder="match value"
    />
  );
}

// ---------------------------------------------------------------------------
// Test-resolve sidebar
// ---------------------------------------------------------------------------

function TestResolveSidebar({
  siteId,
  personas,
}: {
  siteId: string;
  personas: Persona[];
}) {
  const [contextJson, setContextJson] = useState<string>('{\n  "utm.campaign": "mcp-security"\n}');
  const [result, setResult] = useState<{
    persona: Persona | null;
    matched: PersonaCondition | null;
    error: string | null;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  async function run() {
    setTesting(true);
    try {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(contextJson);
      } catch (err) {
        setResult({
          persona: null,
          matched: null,
          error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      const { result: r, error } = await PersonasService.testResolve({
        siteId,
        renderContext: parsed,
      });
      if (error) {
        setResult({ persona: null, matched: null, error });
        return;
      }
      setResult({
        persona: r?.resolved?.persona ?? null,
        matched: r?.resolved?.matched_condition ?? null,
        error: null,
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card className="p-4 sticky top-4">
      <div className="flex items-center gap-2 mb-2">
        <BeakerIcon className="w-4 h-4" />
        <h3 className="font-medium">Test rules</h3>
      </div>
      <p className="text-xs text-(--gray-9) mb-3">
        Enter a sample RenderContext and see which persona would resolve. Mirrors the runtime API exactly.
      </p>
      <Textarea
        value={contextJson}
        onChange={(e) => setContextJson(e.target.value)}
        rows={8}
        className="font-mono text-xs"
      />
      <Button color="primary" onClick={run} disabled={testing || personas.length === 0} className="w-full mt-2">
        {testing ? 'Resolving…' : 'Resolve'}
      </Button>

      {result && (
        <div className="mt-4 pt-4 border-t border-(--gray-5)">
          {result.error ? (
            <div className="flex items-start gap-2 text-(--red-11)">
              <XCircleIcon className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <p className="text-sm">{result.error}</p>
            </div>
          ) : result.persona ? (
            <div>
              <div className="flex items-start gap-2 text-(--green-11)">
                <CheckCircleIcon className="w-5 h-5 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium">{result.persona.label}</p>
                  <p className="text-xs text-(--gray-9)">name: {result.persona.name}</p>
                </div>
              </div>
              {result.matched ? (
                <div className="mt-3 p-2 bg-(--gray-2) rounded text-xs">
                  Matched: <code className="font-mono">{formatConditionShort(result.matched)}</code>
                  {result.matched.persist && (
                    <span className="block mt-1 text-(--gray-9)">→ cookie will be set</span>
                  )}
                </div>
              ) : (
                <p className="mt-3 text-xs text-(--gray-9) italic">
                  No specific rule matched — this is the default persona.
                </p>
              )}
            </div>
          ) : (
            <div className="flex items-start gap-2 text-(--gray-11)">
              <XCircleIcon className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <p className="text-sm">No persona resolved. Add a default persona to handle unmatched requests.</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
