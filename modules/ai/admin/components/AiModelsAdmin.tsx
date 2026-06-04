/**
 * Admin: AI model catalog.
 *
 * One row per (provider, model) — backed by ai_model_prices (we collapse
 * to the latest effective_from per model so the catalog is flat). Editing
 * label/capabilities/pricing updates the latest row in place; historical
 * cost-ledger accuracy is preserved by ai_usage_events snapshotting
 * cost_micro_usd at write time, so price edits don't retroactively rewrite
 * past usage.
 *
 * Operators add new models here as providers release them, and the
 * use-case admin page reads from this catalog to populate its "Default
 * model" + "Allowed models" pickers — no more typing model strings.
 */

import { useEffect, useState } from 'react';
import { ArrowPathIcon, PencilIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';

import { Modal, Button, Badge } from '@/components/ui';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

import {
  createCatalogModel,
  deleteCatalogModel,
  listCatalogModels,
  refreshCatalogModels,
  updateCatalogModel,
  type AiCatalogModel,
} from '../utils/aiService';

const PROVIDERS: AiCatalogModel['provider'][] = ['openai', 'anthropic', 'gemini', 'scrapling'];

type Draft = {
  mode: 'create' | 'edit';
  provider: AiCatalogModel['provider'];
  model: string;
  label: string;
  input_per_million_usd: string;
  output_per_million_usd: string;
  cached_per_million_usd: string;
  cache_creation_per_million_usd: string;
  image_per_image_usd: string;
  supports_chat: boolean;
  supports_tools: boolean;
  supports_web_search: boolean;
  supports_image_gen: boolean;
  supports_embeddings: boolean;
};

function blankDraft(provider: AiCatalogModel['provider'] = 'anthropic'): Draft {
  return {
    mode: 'create',
    provider,
    model: '',
    label: '',
    input_per_million_usd: '0',
    output_per_million_usd: '0',
    cached_per_million_usd: '',
    cache_creation_per_million_usd: '',
    image_per_image_usd: '',
    supports_chat: true,
    supports_tools: false,
    supports_web_search: false,
    supports_image_gen: false,
    supports_embeddings: false,
  };
}

function fromRow(row: AiCatalogModel): Draft {
  return {
    mode: 'edit',
    provider: row.provider,
    model: row.model,
    label: row.label ?? '',
    input_per_million_usd: String(row.input_per_million_usd ?? 0),
    output_per_million_usd: String(row.output_per_million_usd ?? 0),
    cached_per_million_usd: row.cached_per_million_usd == null ? '' : String(row.cached_per_million_usd),
    cache_creation_per_million_usd:
      row.cache_creation_per_million_usd == null
        ? ''
        : String(row.cache_creation_per_million_usd),
    image_per_image_usd: row.image_per_image_usd == null ? '' : String(row.image_per_image_usd),
    supports_chat: row.supports_chat,
    supports_tools: row.supports_tools,
    supports_web_search: row.supports_web_search,
    supports_image_gen: row.supports_image_gen,
    supports_embeddings: row.supports_embeddings,
  };
}

function parseOptionalNumber(raw: string): number | null {
  const v = raw.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default function AiModelsAdmin() {
  const [models, setModels] = useState<AiCatalogModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState<{ provider: AiCatalogModel['provider']; model: string } | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      setModels(await listCatalogModels());
    } catch (err) {
      console.error('[ai-models] load failed', err);
      toast.error('Failed to load model catalog');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!draft) return;
    if (!draft.model.trim()) {
      toast.error('Model id is required');
      return;
    }
    const payload = {
      label: draft.label.trim(),
      input_per_million_usd: Number(draft.input_per_million_usd) || 0,
      output_per_million_usd: Number(draft.output_per_million_usd) || 0,
      cached_per_million_usd: parseOptionalNumber(draft.cached_per_million_usd),
      cache_creation_per_million_usd: parseOptionalNumber(draft.cache_creation_per_million_usd),
      image_per_image_usd: parseOptionalNumber(draft.image_per_image_usd),
      supports_chat: draft.supports_chat,
      supports_tools: draft.supports_tools,
      supports_web_search: draft.supports_web_search,
      supports_image_gen: draft.supports_image_gen,
      supports_embeddings: draft.supports_embeddings,
    };
    setSaving(true);
    try {
      if (draft.mode === 'create') {
        await createCatalogModel({ provider: draft.provider, model: draft.model.trim(), ...payload });
        toast.success(`Added ${draft.provider}/${draft.model.trim()}`);
      } else {
        await updateCatalogModel(draft.provider, draft.model, payload);
        toast.success(`Updated ${draft.provider}/${draft.model}`);
      }
      setDraft(null);
      await load();
    } catch (err) {
      console.error('[ai-models] save failed', err);
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await deleteCatalogModel(deleting.provider, deleting.model);
      toast.success(`Removed ${deleting.provider}/${deleting.model}`);
      setDeleting(null);
      await load();
    } catch (err) {
      console.error('[ai-models] delete failed', err);
      toast.error('Delete failed');
    }
  }

  if (loading) {
    return <div className="p-8 flex justify-center"><LoadingSpinner /></div>;
  }

  // Group by provider for display.
  const grouped = new Map<string, AiCatalogModel[]>();
  for (const m of models) {
    const arr = grouped.get(m.provider) ?? [];
    arr.push(m);
    grouped.set(m.provider, arr);
  }
  const orderedProviders = PROVIDERS.filter((p) => grouped.has(p))
    .concat(Array.from(grouped.keys()).filter((p) => !PROVIDERS.includes(p as AiCatalogModel['provider'])) as AiCatalogModel['provider'][]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-neutral-500">
          Catalog of provider models the platform knows about. Edits flow into the
          use-case pickers — once a model is here, it's selectable as a default or
          in any use-case's allowed list. Backed by <code>ai_model_prices</code>;
          edits update the latest effective-from row in place.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              try {
                const { job_id } = await refreshCatalogModels();
                toast.success(
                  job_id
                    ? 'Refresh queued — the catalog will update once the worker finishes (~30s).'
                    : 'Refresh queued.',
                );
                // Poll the catalog a couple of times so the UI reflects
                // the changes without making the user click reload.
                setTimeout(() => void load(), 8000);
                setTimeout(() => void load(), 20000);
              } catch (err) {
                console.error('[ai-models] refresh failed', err);
                toast.error('Refresh failed — see console');
              } finally {
                setRefreshing(false);
              }
            }}
            title="Pull the latest model pricing from LiteLLM's public price book and write any deltas into ai_model_prices"
          >
            <ArrowPathIcon className={`size-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing…' : 'Refresh from upstream'}
          </Button>
          <Button onClick={() => setDraft(blankDraft())}>
            <PlusIcon className="size-4 mr-2" />
            Add model
          </Button>
        </div>
      </div>

      {models.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-neutral-500">
          No models in the catalog. Add one to make it selectable in use-cases.
        </div>
      ) : (
        <div className="space-y-4">
          {orderedProviders.map((provider) => (
            <section key={provider}>
              <h2 className="text-sm font-medium mb-2 capitalize">{provider}</h2>
              <div className="rounded-md border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-neutral-50">
                    <tr className="text-left">
                      <th className="px-3 py-2">Model</th>
                      <th className="px-3 py-2">Label</th>
                      <th className="px-3 py-2">Capabilities</th>
                      <th className="px-3 py-2 text-right">Input $/1M</th>
                      <th className="px-3 py-2 text-right">Output $/1M</th>
                      <th className="px-3 py-2 w-20"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(grouped.get(provider) ?? []).map((m) => (
                      <tr key={`${m.provider}:${m.model}`} className="border-t hover:bg-neutral-50">
                        <td className="px-3 py-2 font-mono text-xs">{m.model}</td>
                        <td className="px-3 py-2 text-xs">{m.label || '—'}</td>
                        <td className="px-3 py-2 text-xs space-x-1">
                          {m.supports_chat && <Badge>chat</Badge>}
                          {m.supports_tools && <Badge>tools</Badge>}
                          {m.supports_web_search && <Badge>web</Badge>}
                          {m.supports_image_gen && <Badge>image</Badge>}
                          {m.supports_embeddings && <Badge>embed</Badge>}
                        </td>
                        <td className="px-3 py-2 text-xs text-right tabular-nums">
                          {Number(m.input_per_million_usd).toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-xs text-right tabular-nums">
                          {Number(m.output_per_million_usd).toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-right space-x-1">
                          <button
                            type="button"
                            onClick={() => setDraft(fromRow(m))}
                            className="text-neutral-500 hover:text-neutral-900"
                            title="Edit"
                          >
                            <PencilIcon className="size-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleting({ provider: m.provider, model: m.model })}
                            className="text-red-600 hover:text-red-900"
                            title="Delete"
                          >
                            <TrashIcon className="size-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      {draft && (
        <Modal
          isOpen
          onClose={() => setDraft(null)}
          title={draft.mode === 'create' ? 'Add model' : `Edit ${draft.provider}/${draft.model}`}
          size="lg"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Provider">
                <select
                  className="form-input w-full"
                  value={draft.provider}
                  onChange={(e) => setDraft({ ...draft, provider: e.target.value as AiCatalogModel['provider'] })}
                  disabled={draft.mode === 'edit'}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </Field>
              <Field label="Model id">
                <input
                  className="form-input w-full font-mono text-xs"
                  value={draft.model}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  placeholder="claude-sonnet-4-5"
                  disabled={draft.mode === 'edit'}
                />
              </Field>
            </div>
            <Field label="Label (human-readable)">
              <input
                className="form-input w-full"
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder="Claude Sonnet 4.5"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Input $ per 1M tokens">
                <input
                  type="number"
                  step="0.0001"
                  className="form-input w-full font-mono text-xs"
                  value={draft.input_per_million_usd}
                  onChange={(e) => setDraft({ ...draft, input_per_million_usd: e.target.value })}
                />
              </Field>
              <Field label="Output $ per 1M tokens">
                <input
                  type="number"
                  step="0.0001"
                  className="form-input w-full font-mono text-xs"
                  value={draft.output_per_million_usd}
                  onChange={(e) => setDraft({ ...draft, output_per_million_usd: e.target.value })}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Cache-read $ per 1M (optional)">
                <input
                  type="number"
                  step="0.0001"
                  className="form-input w-full font-mono text-xs"
                  value={draft.cached_per_million_usd}
                  onChange={(e) => setDraft({ ...draft, cached_per_million_usd: e.target.value })}
                  placeholder="blank if no cache discount"
                />
              </Field>
              <Field label="Cache-creation $ per 1M (optional)">
                <input
                  type="number"
                  step="0.0001"
                  className="form-input w-full font-mono text-xs"
                  value={draft.cache_creation_per_million_usd}
                  onChange={(e) => setDraft({ ...draft, cache_creation_per_million_usd: e.target.value })}
                  placeholder="Anthropic ≈ 1.25× input rate"
                />
              </Field>
            </div>
            <Field label="Image $ per image (optional)">
              <input
                type="number"
                step="0.000001"
                className="form-input w-full font-mono text-xs"
                value={draft.image_per_image_usd}
                onChange={(e) => setDraft({ ...draft, image_per_image_usd: e.target.value })}
                placeholder="for image-gen models"
              />
            </Field>
            <Field label="Capabilities">
              <div className="flex flex-wrap gap-3 text-sm">
                {(
                  [
                    ['supports_chat', 'chat'],
                    ['supports_tools', 'tools'],
                    ['supports_web_search', 'web_search'],
                    ['supports_image_gen', 'image_gen'],
                    ['supports_embeddings', 'embeddings'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={draft[key]}
                      onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
                    />
                    <code>{label}</code>
                  </label>
                ))}
              </div>
            </Field>
          </div>
        </Modal>
      )}

      <ConfirmModal
        show={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title="Remove model from catalog"
        message={
          deleting
            ? `Permanently remove ${deleting.provider}/${deleting.model} from the catalog? Past usage events keep their snapshotted cost; any use-case that names this model in its allowed_models list will show it as "uncatalogued" until you re-add it.`
            : ''
        }
        confirmText="Remove"
        confirmVariant="danger"
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-neutral-700 mb-1">{label}</span>
      {children}
    </label>
  );
}
