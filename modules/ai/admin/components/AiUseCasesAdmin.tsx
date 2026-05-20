/**
 * Admin: AI use-cases registry.
 *
 * Lists the use-cases seeded by migration 007 (and any added later via
 * module manifests). Operator can edit defaults, allowed models, web
 * tools, max_output_tokens, and daily cost cap.
 */

import { useEffect, useState } from 'react';
import { PencilIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';

import { Modal, Button, Tabs, type Tab } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Select, TextArea, TextField } from '@radix-ui/themes';

import {
  listAiRecipes,
  listAiSkills,
  listCatalogModels,
  listUseCases,
  microUsdToDollars,
  patchUseCase,
  type AiCatalogModel,
  type AiRecipeRef,
  type AiSkillRef,
  type AiUseCase,
} from '../utils/aiService';

export default function AiUseCasesAdmin() {
  const [useCases, setUseCases] = useState<AiUseCase[]>([]);
  const [catalog, setCatalog] = useState<AiCatalogModel[]>([]);
  const [skills, setSkills] = useState<AiSkillRef[]>([]);
  const [recipes, setRecipes] = useState<AiRecipeRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AiUseCase | null>(null);
  const [saving, setSaving] = useState(false);
  const [editTab, setEditTab] = useState<'settings' | 'models' | 'prompt'>('settings');

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [rows, models, skillRows, recipeRows] = await Promise.all([
        listUseCases(),
        listCatalogModels(),
        listAiSkills(),
        listAiRecipes(),
      ]);
      setUseCases(rows);
      setCatalog(models);
      setSkills(skillRows);
      setRecipes(recipeRows);
    } catch (err) {
      console.error('[ai-use-cases] load failed', err);
      toast.error('Failed to load use-cases');
    } finally {
      setLoading(false);
    }
  }

  // The catalog carries every billable unit — chat models, embeddings,
  // image generation, AND web-tool variants (scrapling fetch_url
  // browser/fast/stealth). The use-case's allowed-models matrix should
  // only show CHAT-capable rows; embeddings/images/web-tools have
  // their own configuration surfaces. Filter on supports_chat.
  const chatCatalog = catalog.filter((m) => m.supports_chat);

  // Catalog grouped by provider, in catalog order (alphabetical).
  const catalogByProvider = new Map<string, AiCatalogModel[]>();
  for (const m of chatCatalog) {
    const arr = catalogByProvider.get(m.provider) ?? [];
    arr.push(m);
    catalogByProvider.set(m.provider, arr);
  }
  // Reverse-lookup by `model` for the default-model picker (we treat
  // model ids as globally unique; the catalog already enforces (provider,
  // model) but the use-case's default_model column doesn't store
  // provider, so collisions across providers would be ambiguous).
  const catalogByModel = new Map<string, AiCatalogModel>();
  for (const m of chatCatalog) {
    if (!catalogByModel.has(m.model)) catalogByModel.set(m.model, m);
  }

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    try {
      await patchUseCase(editing.id, {
        label: editing.label,
        description: editing.description,
        default_provider: editing.default_provider,
        default_model: editing.default_model,
        allowed_models: editing.allowed_models,
        allowed_web_tools: editing.allowed_web_tools,
        max_output_tokens: editing.max_output_tokens,
        daily_cost_cap_micro_usd: editing.daily_cost_cap_micro_usd,
        system_prompt: editing.system_prompt,
        kickoff_message: editing.kickoff_message,
        skill_source_id: editing.skill_source_id,
        skill_path: editing.skill_path,
        recipe_source_id: editing.recipe_source_id,
        recipe_file_path: editing.recipe_file_path,
      });
      toast.success('Use-case updated');
      setEditing(null);
      await load();
    } catch (err) {
      console.error('[ai-use-cases] save failed', err);
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="p-8 flex justify-center"><LoadingSpinner /></div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-500">
        Each Gatewaze AI surface registers as a use-case here. Edit defaults to
        control provider, model, and per-use-case spend caps. Adding new use-cases
        happens via module manifest declarations during install.
      </p>

      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50">
            <tr className="text-left">
              <th className="px-3 py-2">ID</th>
              <th className="px-3 py-2">Default provider/model</th>
              <th className="px-3 py-2">Allowed models</th>
              <th className="px-3 py-2">Web tools</th>
              <th className="px-3 py-2 text-right">Daily cap</th>
              <th className="px-3 py-2 w-12"></th>
            </tr>
          </thead>
          <tbody>
            {useCases.map((u) => (
              <tr key={u.id} className="border-t hover:bg-neutral-50">
                <td className="px-3 py-2">
                  <div className="font-medium font-mono text-xs">{u.id}</div>
                  <div className="text-xs text-neutral-500">{u.label}</div>
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {u.default_provider} / {u.default_model}
                </td>
                <td className="px-3 py-2 text-xs">{u.allowed_models.join(', ') || '—'}</td>
                <td className="px-3 py-2 text-xs">{u.allowed_web_tools.join(', ') || '—'}</td>
                <td className="px-3 py-2 text-right text-xs">
                  {u.daily_cost_cap_micro_usd
                    ? microUsdToDollars(u.daily_cost_cap_micro_usd) + '/day'
                    : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => {
                      setEditTab('settings');
                      setEditing({ ...u });
                    }}
                    className="text-neutral-500 hover:text-neutral-900"
                  >
                    <PencilIcon className="size-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <Modal
          isOpen
          onClose={() => setEditing(null)}
          title={`Edit ${editing.id}`}
          size="lg"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <Tabs
              value={editTab}
              onChange={(v) => setEditTab(v as 'settings' | 'models' | 'prompt')}
              tabs={EDIT_TABS}
            />

            {editTab === 'settings' && (
              <SettingsTab editing={editing} setEditing={setEditing} />
            )}
            {editTab === 'models' && (
              <ModelsTab
                editing={editing}
                setEditing={setEditing}
                catalog={catalog}
                catalogByProvider={catalogByProvider}
                catalogByModel={catalogByModel}
              />
            )}
            {editTab === 'prompt' && (
              <PromptTab
                editing={editing}
                setEditing={setEditing}
                skills={skills}
                recipes={recipes}
              />
            )}
          </div>
        </Modal>
      )}
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

const EDIT_TABS: Tab[] = [
  { id: 'settings', label: 'Settings' },
  { id: 'models', label: 'Models' },
  { id: 'prompt', label: 'Prompt' },
];

/**
 * Settings tab — identity (label, description) and runtime gates
 * (token cap, daily cost cap, web-tool allowlist). Model + prompt
 * live on their own tabs so an operator scanning for "what does this
 * use case cost" doesn't have to scroll past the allowed-models matrix.
 */
function SettingsTab({
  editing,
  setEditing,
}: {
  editing: AiUseCase;
  setEditing: (uc: AiUseCase) => void;
}) {
  return (
    <div className="space-y-4">
      <Field label="Label">
        <TextField.Root
          value={editing.label}
          onChange={(e) => setEditing({ ...editing, label: e.target.value })}
        />
      </Field>
      <Field label="Description">
        <TextArea
          rows={2}
          value={editing.description}
          onChange={(e) => setEditing({ ...editing, description: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Max output tokens">
          <TextField.Root
            type="number"
            value={String(editing.max_output_tokens)}
            onChange={(e) =>
              setEditing({ ...editing, max_output_tokens: parseInt(e.target.value, 10) || 0 })
            }
          />
        </Field>
        <Field label="Daily cap (micro-USD, blank = no cap)">
          <TextField.Root
            type="number"
            value={editing.daily_cost_cap_micro_usd == null ? '' : String(editing.daily_cost_cap_micro_usd)}
            onChange={(e) => {
              const v = e.target.value.trim();
              setEditing({ ...editing, daily_cost_cap_micro_usd: v ? parseInt(v, 10) : null });
            }}
          />
        </Field>
      </div>
      <Field label="Allowed web tools">
        <div className="flex flex-col gap-1.5 text-sm">
          {(
            [
              {
                id: 'web_search' as const,
                label: 'Anthropic-native web_search (provider-billed, ~$10/1k requests)',
              },
              {
                id: 'fetch_url' as const,
                label: 'fetch_url via scrapling-fetcher (browser / fast / stealth modes)',
              },
              {
                id: 'gatewaze_search' as const,
                label: 'gatewaze_search — Serper.dev when SERPER_API_KEY is set, else DuckDuckGo via scrapling',
              },
            ]
          ).map((tool) => (
            <label key={tool.id} className="inline-flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={editing.allowed_web_tools.includes(tool.id)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? Array.from(new Set([...editing.allowed_web_tools, tool.id]))
                    : editing.allowed_web_tools.filter((t) => t !== tool.id);
                  setEditing({ ...editing, allowed_web_tools: next });
                }}
              />
              <span>
                <code className="font-mono text-xs">{tool.id}</code>
                <span className="text-xs text-neutral-500"> — {tool.label}</span>
              </span>
            </label>
          ))}
        </div>
      </Field>
    </div>
  );
}

/**
 * Models tab — default provider/model picker + allowed-models matrix.
 * Walked by the router when default_provider='auto'; falls back if
 * the default model is unavailable.
 */
function ModelsTab({
  editing,
  setEditing,
  catalog,
  catalogByProvider,
  catalogByModel,
}: {
  editing: AiUseCase;
  setEditing: (uc: AiUseCase) => void;
  catalog: AiCatalogModel[];
  catalogByProvider: Map<string, AiCatalogModel[]>;
  catalogByModel: Map<string, AiCatalogModel>;
}) {
  return (
    <div className="space-y-4">
      <Field label="Default model">
        <Select.Root
          value={
            editing.default_provider === 'auto'
              ? 'auto'
              : `${editing.default_provider}:${editing.default_model}`
          }
          onValueChange={(v) => {
            if (v === 'auto') {
              // Keep the existing default_model string so the DB-level
              // NOT NULL stays satisfied — when default_provider='auto'
              // the router walks allowed_models anyway and default_model
              // is just a fallback.
              setEditing({ ...editing, default_provider: 'auto' });
              return;
            }
            const [provider, ...rest] = v.split(':');
            setEditing({
              ...editing,
              default_provider: provider as AiUseCase['default_provider'],
              default_model: rest.join(':'),
            });
          }}
        >
          <Select.Trigger className="w-full" />
          <Select.Content>
            <Select.Item value="auto">Auto (walk allowed_models)</Select.Item>
            {Array.from(catalogByProvider.entries()).map(([provider, models]) => (
              <Select.Group key={provider}>
                <Select.Label>{provider}</Select.Label>
                {models.map((m) => (
                  <Select.Item key={`${provider}:${m.model}`} value={`${provider}:${m.model}`}>
                    {m.label ? `${m.label} (${m.model})` : m.model}
                  </Select.Item>
                ))}
              </Select.Group>
            ))}
            {editing.default_provider !== 'auto' &&
              editing.default_model &&
              !catalog.some(
                (m) => m.provider === editing.default_provider && m.model === editing.default_model,
              ) && (
                <Select.Item value={`${editing.default_provider}:${editing.default_model}`}>
                  {editing.default_provider}:{editing.default_model} (uncatalogued)
                </Select.Item>
              )}
          </Select.Content>
        </Select.Root>
        {editing.default_provider !== 'auto' &&
          editing.default_model &&
          !catalogByModel.has(editing.default_model) && (
            <p className="text-xs text-amber-600 mt-1">
              This model is not in the catalog. Add it via the AI models page so
              pricing + capabilities resolve correctly.
            </p>
          )}
      </Field>
      <Field label="Allowed models">
        <div className="space-y-3 border rounded-md p-3 bg-neutral-50/40 max-h-[28rem] overflow-y-auto">
          {catalog.length === 0 ? (
            <p className="text-xs text-neutral-500">
              No models in the catalog yet — add some via the AI models page.
            </p>
          ) : (
            Array.from(catalogByProvider.entries()).map(([provider, models]) => (
              <div key={provider}>
                <div className="text-xs font-medium text-neutral-600 capitalize mb-1">
                  {provider}
                </div>
                <div className="grid grid-cols-1 gap-1">
                  {models.map((m) => {
                    const checked = editing.allowed_models.includes(m.model);
                    return (
                      <label key={m.model} className="inline-flex items-start gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={checked}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...editing.allowed_models, m.model]
                              : editing.allowed_models.filter((x) => x !== m.model);
                            setEditing({ ...editing, allowed_models: next });
                          }}
                        />
                        <span>
                          <span className="font-mono">{m.model}</span>
                          {m.label && <span className="text-neutral-500"> — {m.label}</span>}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))
          )}
          {editing.allowed_models.filter((m) => !catalogByModel.has(m)).length > 0 && (
            <div>
              <div className="text-xs font-medium text-amber-700 mb-1">Uncatalogued</div>
              <div className="grid grid-cols-1 gap-1">
                {editing.allowed_models
                  .filter((m) => !catalogByModel.has(m))
                  .map((m) => (
                    <label key={m} className="inline-flex items-start gap-2 text-xs">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked
                        onChange={() =>
                          setEditing({
                            ...editing,
                            allowed_models: editing.allowed_models.filter((x) => x !== m),
                          })
                        }
                      />
                      <span className="font-mono">{m}</span>
                    </label>
                  ))}
              </div>
            </div>
          )}
        </div>
        <p className="text-xs text-neutral-500 mt-1">
          Order reflects selection sequence — the router walks this list when
          default_provider is Auto, or as fallback if the default model is unavailable.
        </p>
      </Field>
    </div>
  );
}

/**
 * Prompt tab — system-prompt source. Binding picker + inline
 * fallback prompt + kickoff message live here so an operator can
 * focus on the prompt shape without scrolling past model config.
 */
function PromptTab({
  editing,
  setEditing,
  skills,
  recipes,
}: {
  editing: AiUseCase;
  setEditing: (uc: AiUseCase) => void;
  skills: AiSkillRef[];
  recipes: AiRecipeRef[];
}) {
  return (
    <div className="space-y-4">
      <BindingPicker
        editing={editing}
        setEditing={setEditing}
        skills={skills}
        recipes={recipes}
      />
      <Field label="System prompt (inline fallback)">
        <TextArea
          rows={8}
          value={editing.system_prompt}
          onChange={(e) => setEditing({ ...editing, system_prompt: e.target.value })}
          placeholder="The instructions the model receives on every turn. Editorial guidelines, output format requirements, persona, etc."
          style={{ fontFamily: 'var(--code-font-family, ui-monospace, monospace)', fontSize: '12px' }}
        />
      </Field>
      <Field label="Kickoff message (initial user turn for Run Research / Run on all tabs)">
        <TextArea
          rows={3}
          value={editing.kickoff_message}
          onChange={(e) => setEditing({ ...editing, kickoff_message: e.target.value })}
          placeholder="Leave blank to start with no user message — the system prompt alone drives the model. Otherwise this is the first user turn sent when the operator clicks Run Research."
        />
      </Field>
    </div>
  );
}

/**
 * Unified binding picker — Skill XOR Recipe XOR None.
 *
 * Replaces the standalone Skill dropdown after migration 025 added
 * recipe binding columns. The two bindings are mutually exclusive at
 * the DB level (CHECK constraint); the radio toggle here enforces it
 * at the UI level so an operator can't even attempt to set both.
 *
 *   - None: use the inline system_prompt field below.
 *   - Skill: bind to ai_skills row; skill body becomes the system
 *     prompt at runtime.
 *   - Recipe: bind to ai_recipes row; "Run" enqueues an ai:run-recipe
 *     job (the recipe carries its own prompt + workflow).
 */
function BindingPicker({
  editing,
  setEditing,
  skills,
  recipes,
}: {
  editing: AiUseCase;
  setEditing: (uc: AiUseCase) => void;
  skills: AiSkillRef[];
  recipes: AiRecipeRef[];
}) {
  type Kind = 'none' | 'skill' | 'recipe';

  // Derive the initial radio choice from the FK columns; after that,
  // the radio is its OWN local state so the operator can flip to
  // 'skill' / 'recipe' BEFORE picking a value from the dropdown. We
  // can't derive kind from the FKs alone because empty FKs would
  // snap the radio back to 'none' the moment the operator clicks
  // 'skill' (the FKs only fill once they pick an option below).
  const derivedKind: Kind = editing.recipe_source_id
    ? 'recipe'
    : editing.skill_source_id
      ? 'skill'
      : 'none';
  const [kind, setKindState] = useState<Kind>(derivedKind);

  function setKind(k: Kind) {
    setKindState(k);
    if (k === 'none') {
      setEditing({
        ...editing,
        skill_source_id: null,
        skill_path: null,
        recipe_source_id: null,
        recipe_file_path: null,
      });
    } else if (k === 'skill') {
      // Clear the OPPOSITE binding so we don't violate the
      // mutual-exclusion CHECK constraint at save time. Skill FKs
      // stay empty until the operator picks from the dropdown.
      setEditing({
        ...editing,
        recipe_source_id: null,
        recipe_file_path: null,
      });
    } else {
      setEditing({
        ...editing,
        skill_source_id: null,
        skill_path: null,
      });
    }
  }

  return (
    <div className="space-y-2">
      <span className="block text-sm font-medium text-neutral-700">
        Binding (system prompt source)
      </span>
      <div role="radiogroup" className="flex items-center gap-4 text-sm">
        {(['none', 'skill', 'recipe'] as const).map((k) => (
          <label key={k} className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="binding-kind"
              checked={kind === k}
              onChange={() => setKind(k)}
            />
            <span className="capitalize">
              {k === 'none' ? 'None (inline prompt)' : k}
            </span>
          </label>
        ))}
      </div>

      {kind === 'skill' && (
        <div className="pt-1">
          <select
            className="form-input w-full"
            value={
              editing.skill_source_id && editing.skill_path
                ? `${editing.skill_source_id}:${editing.skill_path}`
                : ''
            }
            onChange={(e) => {
              const v = e.target.value;
              if (!v) {
                setEditing({ ...editing, skill_source_id: null, skill_path: null });
                return;
              }
              const sep = v.indexOf(':');
              setEditing({
                ...editing,
                skill_source_id: v.slice(0, sep),
                skill_path: v.slice(sep + 1),
              });
            }}
          >
            <option value="">— Choose a skill —</option>
            {skills.map((s) => (
              <option key={s.id} value={`${s.source_id}:${s.path}`}>
                {s.source_label} · {s.name} ({s.path})
              </option>
            ))}
          </select>
          <p className="text-xs text-neutral-500 mt-1">
            Skill body becomes the system prompt at runtime. The inline prompt
            below is the fallback when the skill row is missing.
            {skills.length === 0 && (
              <>
                {' '}
                <strong>No skills indexed yet</strong> — add a source in the{' '}
                <strong>Agent sources</strong> tab and wait for sync.
              </>
            )}
          </p>
        </div>
      )}

      {kind === 'recipe' && (
        <div className="pt-1">
          <select
            className="form-input w-full"
            value={
              editing.recipe_source_id && editing.recipe_file_path
                ? `${editing.recipe_source_id}:${editing.recipe_file_path}`
                : ''
            }
            onChange={(e) => {
              const v = e.target.value;
              if (!v) {
                setEditing({
                  ...editing,
                  recipe_source_id: null,
                  recipe_file_path: null,
                });
                return;
              }
              const sep = v.indexOf(':');
              setEditing({
                ...editing,
                recipe_source_id: v.slice(0, sep),
                recipe_file_path: v.slice(sep + 1),
              });
            }}
          >
            <option value="">— Choose a recipe —</option>
            {recipes.map((r) => (
              <option key={r.id} value={`${r.source_id}:${r.file_path}`}>
                {r.source_label} · {r.title} ({r.file_path})
              </option>
            ))}
          </select>
          <p className="text-xs text-neutral-500 mt-1">
            "Run" on this use case enqueues an <code>ai:run-recipe</code> job
            against the bound recipe. The inline prompt below is ignored.
            {recipes.length === 0 && (
              <>
                {' '}
                <strong>No recipes indexed yet</strong> — add a source in the{' '}
                <strong>Agent sources</strong> tab and wait for sync.
              </>
            )}
          </p>
        </div>
      )}

      {kind === 'none' && (
        <p className="text-xs text-neutral-500">
          Use the inline <strong>System prompt</strong> field below. Skills + recipes are managed in the{' '}
          <strong>Agent sources</strong> tab.
        </p>
      )}
    </div>
  );
}
