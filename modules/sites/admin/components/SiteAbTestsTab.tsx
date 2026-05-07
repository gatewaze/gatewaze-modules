/**
 * Experiments tab — A/B tests for a site.
 *
 * v1 scope:
 *   - List existing tests (templates_ab_tests with host_kind='site')
 *   - "+ New experiment" creates a draft test with N variants summing to 100%
 *   - Per-row actions: start (draft → running), pause (running → paused),
 *     resume (paused → running), conclude (→ concluded with optional winner)
 *   - Per-variant counters from templates_ab_events
 *
 * Out of scope for v1 (callouts visible in the empty state):
 *   - Per-variant content storage (today the test record is metadata only;
 *     the renderer doesn't yet branch on variant). The schema lets you
 *     attach pages_content_variants rows keyed by `match_context.variant`,
 *     but the publish-worker hasn't been taught to emit branched content
 *     yet — that lands when the engine wiring (recordImpression in the
 *     emit-nextjs-routes flow) is in place.
 *   - Statistical-significance computation. Tab shows raw counts only.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, Input, Modal } from '@/components/ui';
import { PlayIcon, PauseIcon, FlagIcon, TrashIcon, BeakerIcon, TrophyIcon } from '@heroicons/react/24/outline';
import { useForm, useFieldArray } from 'react-hook-form';
import { supabase } from '@/lib/supabase';
import { SchemaEditor } from '../schema-editor';
import type { SchemaNode } from '../schema-editor/index.js';
import {
  AbTestsService,
  AbVariantsService,
  PagesService,
  type AbTestSummary,
  type AbVariant,
  type AbVariantContentRow,
  type PageSummary,
} from '../services/sitesService';
import type { SiteRow } from '../../types';

interface CreateForm {
  name: string;
  pageId: string;
  goal_event: string;
  variants: AbVariant[];
}

export function SiteAbTestsTab({ site }: { site: SiteRow }) {
  const [tests, setTests] = useState<AbTestSummary[]>([]);
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<CreateForm>({
    defaultValues: {
      name: '',
      pageId: '',
      goal_event: 'signup_clicked',
      variants: [
        { key: 'control', weight: 50 },
        { key: 'variant-a', weight: 50 },
      ],
    },
  });
  const { register, handleSubmit, control, reset, watch, formState: { errors } } = form;
  const { fields, append, remove } = useFieldArray({ control, name: 'variants' });
  const watchedVariants = watch('variants');
  const totalWeight = watchedVariants.reduce((s, v) => s + Number(v.weight ?? 0), 0);

  const reload = async () => {
    setLoading(true);
    const [testsRes, pagesRes] = await Promise.all([
      AbTestsService.listForSite(site.id),
      PagesService.listPages(site.id),
    ]);
    if (testsRes.error) toast.error(`Tests: ${testsRes.error}`);
    if (pagesRes.error) toast.error(`Pages: ${pagesRes.error}`);
    setTests(testsRes.tests);
    setPages(pagesRes.pages);
    setLoading(false);
  };

  useEffect(() => { reload(); }, [site.id]);

  const onCreate = async (data: CreateForm) => {
    setSubmitting(true);
    const { error } = await AbTestsService.createTest({
      siteId: site.id,
      scope_kind: 'page',
      scope_id: data.pageId,
      name: data.name,
      variants: data.variants.map((v) => ({ key: v.key, weight: Number(v.weight) })),
      goal_event: data.goal_event,
    });
    setSubmitting(false);
    if (error) {
      toast.error(`Create failed: ${error}`);
      return;
    }
    toast.success(`Experiment "${data.name}" created (draft)`);
    setShowCreate(false);
    reset();
    reload();
  };

  const onStatusChange = async (testId: string, status: 'running' | 'paused' | 'concluded') => {
    const { error } = await AbTestsService.setStatus(testId, status);
    if (error) {
      toast.error(`Status update failed: ${error}`);
      return;
    }
    reload();
  };

  const onDelete = async (testId: string, name: string) => {
    if (!confirm(`Delete experiment "${name}"? This removes its assignments and event history.`)) return;
    const { error } = await AbTestsService.deleteTest(testId);
    if (error) {
      toast.error(`Delete failed: ${error}`);
      return;
    }
    toast.success('Experiment deleted');
    reload();
  };

  const onPromoteWinner = async (testId: string, pageId: string, variant: string) => {
    if (!confirm(`Promote "${variant}" as the page's default content? This swaps pages.content with the variant's content and concludes the experiment. Re-publish to make it live.`)) return;
    const { error } = await AbTestsService.promoteWinner({ testId, pageId, variant });
    if (error) {
      toast.error(`Promote failed: ${error}`);
      return;
    }
    toast.success(`Promoted "${variant}" — page default updated, experiment concluded. Re-publish to ship.`);
    reload();
  };

  const pageById = (id: string) => pages.find((p) => p.id === id);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-2">
            <BeakerIcon className="size-5 text-[var(--accent-9)]" />
            <h3 className="text-sm font-semibold">Experiments</h3>
          </div>
          <Button onClick={() => setShowCreate(true)} disabled={pages.length === 0}>
            + New experiment
          </Button>
        </div>
        {pages.length === 0 && (
          <div className="px-4 pb-4 text-sm text-[var(--gray-a8)]">
            Create a page first — experiments target a specific page (scope_kind=page).
          </div>
        )}
      </Card>

      {!loading && tests.length === 0 && pages.length > 0 && (
        <Card>
          <div className="p-6 text-sm text-[var(--gray-a8)] text-center">
            No experiments yet. Click "+ New experiment" to set up a draft test with two or
            more variants. Status flips draft → running when you start it; the renderer reads
            the assigned variant per session and records impressions / conversions in
            <span className="font-mono"> templates_ab_events</span>.
          </div>
        </Card>
      )}

      {tests.map((t) => {
        const page = pageById(t.scope_id);
        return (
          <Card key={t.id}>
            <div className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-semibold text-[var(--gray-12)]">{t.name}</h4>
                    <StatusBadge status={t.status} />
                  </div>
                  <p className="text-xs text-[var(--gray-a8)] mt-0.5">
                    Page: {page ? <span className="font-mono">{page.full_path}</span> : <span className="italic">unknown ({t.scope_id.slice(0, 8)}…)</span>}
                    <span className="mx-2">·</span>
                    Goal: <span className="font-mono">{t.goal_event}</span>
                    {t.started_at && (
                      <>
                        <span className="mx-2">·</span>
                        Started {new Date(t.started_at).toLocaleString()}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {t.status === 'draft' && (
                    <Button size="sm" variant="ghost" onClick={() => onStatusChange(t.id, 'running')} title="Start">
                      <PlayIcon className="size-4" />
                    </Button>
                  )}
                  {t.status === 'running' && (
                    <Button size="sm" variant="ghost" onClick={() => onStatusChange(t.id, 'paused')} title="Pause">
                      <PauseIcon className="size-4" />
                    </Button>
                  )}
                  {t.status === 'paused' && (
                    <Button size="sm" variant="ghost" onClick={() => onStatusChange(t.id, 'running')} title="Resume">
                      <PlayIcon className="size-4" />
                    </Button>
                  )}
                  {(t.status === 'running' || t.status === 'paused') && (
                    <Button size="sm" variant="ghost" onClick={() => onStatusChange(t.id, 'concluded')} title="Conclude">
                      <FlagIcon className="size-4" />
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" color="red" onClick={() => onDelete(t.id, t.name)} title="Delete">
                    <TrashIcon className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {t.variantStats.map((v) => {
                  const cvr = v.impressions > 0 ? ((v.conversions / v.impressions) * 100).toFixed(1) : '—';
                  const declared = t.variants.find((x) => x.key === v.key);
                  const canPromote = page && (t.status === 'running' || t.status === 'paused');
                  return (
                    <div key={v.key} className="rounded-md bg-[var(--gray-a2)] p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[var(--gray-12)]">{v.key}</span>
                        <span className="text-xs text-[var(--gray-a8)]">{declared?.weight ?? 0}%</span>
                      </div>
                      <div className="mt-1 text-xs text-[var(--gray-a8)]">
                        <span>{v.impressions.toLocaleString()} imp</span>
                        <span className="mx-2">·</span>
                        <span>{v.conversions.toLocaleString()} conv</span>
                        <span className="mx-2">·</span>
                        <span>cvr {cvr}{cvr !== '—' && '%'}</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        {t.winner_variant === v.key ? (
                          <Badge variant="soft" color="green" size="1">winner</Badge>
                        ) : <span />}
                        {canPromote && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => page && onPromoteWinner(t.id, page.id, v.key)}
                            title={`Adopt "${v.key}" as the page default`}
                          >
                            <TrophyIcon className="size-4" /> Promote
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {page && (
                <VariantContentPanel pageId={page.id} testId={t.id} variants={t.variants} />
              )}
            </div>
          </Card>
        );
      })}

      <Modal
        isOpen={showCreate}
        onClose={() => { setShowCreate(false); reset(); }}
        title="New experiment"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outlined" onClick={() => { setShowCreate(false); reset(); }} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit(onCreate)}
              disabled={submitting || Math.abs(totalWeight - 100) > 0.001}
            >
              {submitting ? 'Creating…' : 'Create draft'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Input
            label="Name"
            placeholder="Hero copy v2"
            {...register('name', { required: 'Name is required' })}
            error={errors.name?.message}
          />
          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Page</label>
            <select
              {...register('pageId', { required: 'Pick a page' })}
              className="w-full px-3 py-2 bg-transparent border border-[var(--gray-a5)] rounded-lg focus:outline-none focus:border-[var(--accent-9)] text-[var(--gray-12)]"
            >
              <option value="">— pick a page —</option>
              {pages.map((p) => (
                <option key={p.id} value={p.id}>{p.full_path} — {p.title}</option>
              ))}
            </select>
            {errors.pageId?.message && (
              <p className="mt-1 text-sm text-[var(--error-11)]">{errors.pageId.message}</p>
            )}
          </div>
          <Input
            label="Goal event"
            placeholder="signup_clicked"
            {...register('goal_event', { required: 'Goal event is required' })}
            error={errors.goal_event?.message}
          />
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-[var(--gray-12)]">
                Variants <span className="text-xs text-[var(--gray-a8)]">(weights must sum to 100)</span>
              </label>
              <Button
                size="sm"
                variant="outlined"
                type="button"
                onClick={() => append({ key: `variant-${fields.length}`, weight: 0 })}
              >
                + Add variant
              </Button>
            </div>
            <div className="space-y-2">
              {fields.map((f, idx) => (
                <div key={f.id} className="flex items-center gap-2">
                  <Input
                    placeholder="key"
                    {...register(`variants.${idx}.key` as const, { required: true })}
                    className="flex-1"
                  />
                  <Input
                    type="number"
                    placeholder="weight"
                    {...register(`variants.${idx}.weight` as const, { valueAsNumber: true, min: 0, max: 100 })}
                    className="w-24"
                  />
                  {fields.length > 2 && (
                    <Button size="sm" variant="ghost" type="button" onClick={() => remove(idx)} aria-label="Remove">
                      <TrashIcon className="size-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <p
              className={`mt-1 text-xs ${
                Math.abs(totalWeight - 100) > 0.001
                  ? 'text-[var(--warning-11)]'
                  : 'text-[var(--gray-a8)]'
              }`}
            >
              Total: {totalWeight}% {Math.abs(totalWeight - 100) > 0.001 && '(must be 100)'}
            </p>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function StatusBadge({ status }: { status: 'draft' | 'running' | 'paused' | 'concluded' }) {
  const colorMap: Record<typeof status, 'neutral' | 'success' | 'warning' | 'info'> = {
    draft: 'neutral',
    running: 'success',
    paused: 'warning',
    concluded: 'info',
  };
  return <Badge color={colorMap[status]}>{status}</Badge>;
}

// ----------------------------------------------------------------------------
// Variant content editor — per-variant JSON content stored in
// pages_content_variants. Operators paste a partial-content JSON for each
// variant; the renderer emits per-variant files and the bootstrap script
// exposes them at window.gatewazeAB.variantContent for the host theme.
// ----------------------------------------------------------------------------

interface PageSchemaContext {
  schemaJson: SchemaNode;
  schemaVersion: number;
  fullPath: string;
}

export function VariantContentPanel({
  pageId,
  testId,
  variants,
}: {
  pageId: string;
  testId: string;
  variants: ReadonlyArray<AbVariant>;
}) {
  const [rows, setRows] = useState<AbVariantContentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingVariant, setEditingVariant] = useState<string | null>(null);
  const [draft, setDraft] = useState('{}');
  const [saving, setSaving] = useState(false);
  const [pageSchema, setPageSchema] = useState<PageSchemaContext | null>(null);

  const reload = async () => {
    setLoading(true);
    const [{ variants: vs, error }, schemaCtx] = await Promise.all([
      AbVariantsService.listForTest(pageId, testId),
      loadPageSchema(pageId),
    ]);
    if (error) toast.error(`Variant content: ${error}`);
    setRows(vs);
    setPageSchema(schemaCtx);
    setLoading(false);
  };

  useEffect(() => { reload(); }, [pageId, testId]);

  const open = (variantKey: string) => {
    const existing = rows.find((r) => r.variant === variantKey);
    setDraft(JSON.stringify(existing?.content ?? {}, null, 2));
    setEditingVariant(variantKey);
  };

  const save = async () => {
    if (!editingVariant) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(draft) as Record<string, unknown>;
    } catch (err) {
      toast.error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
      toast.error('Variant content must be a JSON object');
      return;
    }
    setSaving(true);
    const { error } = await AbVariantsService.upsertVariantContent({
      pageId,
      testId,
      variant: editingVariant,
      content: parsed,
    });
    setSaving(false);
    if (error) {
      toast.error(`Save failed: ${error}`);
      return;
    }
    toast.success(`Saved content for "${editingVariant}"`);
    setEditingVariant(null);
    reload();
  };

  const saveViaSchemaEditor = async (args: {
    route: string;
    content: Record<string, unknown>;
    schemaVersion: number;
    baseCommitSha: string | null;
  }) => {
    if (!editingVariant) return;
    const { error } = await AbVariantsService.upsertVariantContent({
      pageId,
      testId,
      variant: editingVariant,
      content: args.content,
    });
    if (error) {
      toast.error(`Save failed: ${error}`);
      throw new Error(error);
    }
    toast.success(`Saved content for "${editingVariant}"`);
    setEditingVariant(null);
    reload();
  };

  const clearVariant = async (variantKey: string) => {
    if (!confirm(`Clear content for variant "${variantKey}"? Visitors assigned to this variant will see the page's default content.`)) return;
    const { error } = await AbVariantsService.deleteVariantContent({ pageId, testId, variant: variantKey });
    if (error) {
      toast.error(`Clear failed: ${error}`);
      return;
    }
    toast.success(`Cleared "${variantKey}"`);
    reload();
  };

  if (loading) {
    return <p className="text-xs text-[var(--gray-a8)]">Loading variant content…</p>;
  }

  return (
    <>
      <div className="border-t border-[var(--gray-a3)] pt-3 mt-3 space-y-1.5">
        <div className="text-xs font-medium text-[var(--gray-a8)] uppercase tracking-wide">Variant content</div>
        {variants.map((v) => {
          const has = rows.find((r) => r.variant === v.key);
          return (
            <div key={v.key} className="flex items-center justify-between gap-3 text-sm">
              <div className="min-w-0">
                <span className="font-medium text-[var(--gray-12)]">{v.key}</span>{' '}
                <span className="text-xs text-[var(--gray-a8)]">
                  {has ? 'content set' : 'no content (uses page default)'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => open(v.key)}>
                  Edit
                </Button>
                {has && (
                  <Button size="sm" variant="ghost" color="red" onClick={() => clearVariant(v.key)}>
                    Clear
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Modal
        isOpen={editingVariant !== null}
        onClose={() => setEditingVariant(null)}
        title={`Variant content — ${editingVariant ?? ''}`}
        footer={
          pageSchema ? null : (
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outlined" onClick={() => setEditingVariant(null)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          )
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-[var(--gray-a8)]">
            Content for visitors assigned to <span className="font-mono">{editingVariant}</span>. The publisher
            emits <span className="font-mono">content/pages/&lt;slug&gt;.{editingVariant}.json</span>; the
            bootstrap exposes it at <span className="font-mono">window.gatewazeAB.variantContent</span>.
          </p>
          {pageSchema && editingVariant ? (
            <SchemaEditor
              route={pageSchema.fullPath}
              schema={pageSchema.schemaJson}
              schemaVersion={pageSchema.schemaVersion}
              initialContent={rows.find((r) => r.variant === editingVariant)?.content ?? null}
              baseCommitSha={null}
              onSave={saveViaSchemaEditor}
            />
          ) : (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={16}
              spellCheck={false}
              className="w-full px-3 py-2 font-mono text-xs bg-transparent border border-[var(--gray-a5)] rounded-lg focus:outline-none focus:border-[var(--accent-9)] text-[var(--gray-12)]"
            />
          )}
        </div>
      </Modal>
    </>
  );
}

/**
 * Load the templates_content_schemas row backing this page so the variant
 * editor can use SchemaEditor instead of a raw JSON textarea. Returns null
 * if the page doesn't have a schema bound (older sites or schema-less
 * blocks-mode pages); the panel falls back to the textarea in that case.
 */
async function loadPageSchema(pageId: string): Promise<PageSchemaContext | null> {
  interface PageRow {
    full_path: string;
    templates_library_id: string | null;
    content_schema_version: number | null;
  }
  const { data: page } = await supabase
    .from('pages')
    .select('full_path, templates_library_id, content_schema_version')
    .eq('id', pageId)
    .maybeSingle<PageRow>();
  if (!page?.templates_library_id || !page.content_schema_version) return null;
  interface SchemaRow { schema_json: SchemaNode; version: number; }
  const { data: row } = await supabase
    .from('templates_content_schemas')
    .select('schema_json, version')
    .eq('library_id', page.templates_library_id)
    .eq('version', page.content_schema_version)
    .maybeSingle<SchemaRow>();
  if (!row) return null;
  return {
    schemaJson: row.schema_json,
    schemaVersion: row.version,
    fullPath: page.full_path,
  };
}
