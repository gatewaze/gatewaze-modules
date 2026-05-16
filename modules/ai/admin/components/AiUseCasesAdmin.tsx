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

import { Modal, Button } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

import {
  listUseCases,
  microUsdToDollars,
  patchUseCase,
  type AiUseCase,
} from '../utils/aiService';

export default function AiUseCasesAdmin() {
  const [useCases, setUseCases] = useState<AiUseCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AiUseCase | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const rows = await listUseCases();
      setUseCases(rows);
    } catch (err) {
      console.error('[ai-use-cases] load failed', err);
      toast.error('Failed to load use-cases');
    } finally {
      setLoading(false);
    }
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
    <div className="p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">AI use-cases</h1>
        <p className="text-sm text-neutral-500 mt-1">
          Each Gatewaze AI surface registers as a use-case here. Edit defaults to
          control provider, model, and per-use-case spend caps. Adding new use-cases
          happens via module manifest declarations during install.
        </p>
      </header>

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
                    onClick={() => setEditing({ ...u })}
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
              <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <Field label="Label">
              <input
                className="form-input w-full"
                value={editing.label}
                onChange={(e) => setEditing({ ...editing, label: e.target.value })}
              />
            </Field>
            <Field label="Description">
              <textarea
                className="form-input w-full"
                rows={2}
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Default provider">
                <select
                  className="form-input w-full"
                  value={editing.default_provider}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      default_provider: e.target.value as AiUseCase['default_provider'],
                    })
                  }
                >
                  <option value="auto">auto (walk allowed_models)</option>
                  <option value="openai">openai</option>
                  <option value="anthropic">anthropic</option>
                  <option value="gemini">gemini</option>
                </select>
              </Field>
              <Field label="Default model">
                <input
                  className="form-input w-full font-mono text-xs"
                  value={editing.default_model}
                  onChange={(e) => setEditing({ ...editing, default_model: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Allowed models (comma-separated, ordered)">
              <input
                className="form-input w-full font-mono text-xs"
                value={editing.allowed_models.join(', ')}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    allowed_models: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                  })
                }
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Max output tokens">
                <input
                  type="number"
                  className="form-input w-full"
                  value={editing.max_output_tokens}
                  onChange={(e) => setEditing({ ...editing, max_output_tokens: parseInt(e.target.value, 10) || 0 })}
                />
              </Field>
              <Field label="Daily cap (micro-USD, blank = no cap)">
                <input
                  type="number"
                  className="form-input w-full"
                  value={editing.daily_cost_cap_micro_usd ?? ''}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    setEditing({ ...editing, daily_cost_cap_micro_usd: v ? parseInt(v, 10) : null });
                  }}
                />
              </Field>
            </div>
            <Field label="Allowed web tools">
              <div className="flex gap-3 text-sm">
                {(['web_search', 'fetch_url'] as const).map((tool) => (
                  <label key={tool} className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={editing.allowed_web_tools.includes(tool)}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...new Set([...editing.allowed_web_tools, tool])]
                          : editing.allowed_web_tools.filter((t) => t !== tool);
                        setEditing({ ...editing, allowed_web_tools: next });
                      }}
                    />
                    <code>{tool}</code>
                  </label>
                ))}
              </div>
            </Field>
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
