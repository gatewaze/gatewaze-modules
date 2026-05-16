/**
 * Admin: AI credentials.
 *
 * Two tables: user credentials (per-user overrides) and use-case
 * credentials (pinned to a use-case, used by cron-driven runs).
 *
 * Cleartext keys leave the form ONLY once — when the operator clicks
 * Save, we POST the key, then DROP it from React state. The toast
 * confirms the last 4 chars so the operator can verify what they
 * stored without exposing the full key in the logs.
 */

import { useEffect, useState } from 'react';
import { PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';

import { Modal, Button, Badge } from '@/components/ui';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

import {
  createUserCredential,
  deleteUserCredential,
  listCredentials,
  type AiProvider,
  type AiUseCaseCredentialMeta,
  type AiUserCredentialMeta,
} from '../utils/aiService';

interface NewCredentialDraft {
  userId: string;
  provider: AiProvider;
  apiKey: string;
}

const PROVIDERS: AiProvider[] = ['openai', 'anthropic', 'gemini'];

export default function AiCredentialsAdmin() {
  const [userCreds, setUserCreds] = useState<AiUserCredentialMeta[]>([]);
  const [useCaseCreds, setUseCaseCreds] = useState<AiUseCaseCredentialMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<NewCredentialDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const result = await listCredentials();
      setUserCreds(result.user_credentials);
      setUseCaseCreds(result.use_case_credentials);
    } catch (err) {
      console.error('[ai-credentials] load failed', err);
      toast.error('Failed to load credentials');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!draft) return;
    if (!draft.userId.trim() || !draft.apiKey.trim()) {
      toast.error('Both user_id and api_key are required');
      return;
    }
    setSaving(true);
    try {
      const result = await createUserCredential({
        userId: draft.userId.trim(),
        provider: draft.provider,
        apiKey: draft.apiKey.trim(),
      });
      toast.success(`Credential created (ending …${result.last_4})`);
      setDraft(null);
      await load();
    } catch (err) {
      console.error('[ai-credentials] save failed', err);
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deletingId) return;
    try {
      await deleteUserCredential(deletingId);
      toast.success('Credential deleted');
      setDeletingId(null);
      await load();
    } catch (err) {
      console.error('[ai-credentials] delete failed', err);
      toast.error('Delete failed');
    }
  }

  if (loading) {
    return <div className="p-8 flex justify-center"><LoadingSpinner /></div>;
  }

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">AI credentials</h1>
          <p className="text-sm text-neutral-500 mt-1">
            API keys for individual users. The provider router prefers these over the
            system defaults — useful for assigning specific keys to specific operators
            for cost containment.
          </p>
        </div>
        <Button onClick={() => setDraft({ userId: '', provider: 'anthropic', apiKey: '' })}>
          <PlusIcon className="size-4 mr-2" />
          New user credential
        </Button>
      </header>

      <section>
        <h2 className="text-sm font-medium mb-2">User credentials</h2>
        {userCreds.length === 0 ? (
          <div className="rounded-md border border-dashed p-10 text-center text-sm text-neutral-500">
            No user credentials yet. The system-default env vars are in use for everyone.
          </div>
        ) : (
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50">
                <tr className="text-left">
                  <th className="px-3 py-2">User</th>
                  <th className="px-3 py-2">Provider</th>
                  <th className="px-3 py-2">Key ending</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Last used</th>
                  <th className="px-3 py-2 w-12"></th>
                </tr>
              </thead>
              <tbody>
                {userCreds.map((c) => (
                  <tr key={c.id} className="border-t hover:bg-neutral-50">
                    <td className="px-3 py-2 font-mono text-xs">{c.user_id.slice(0, 8)}</td>
                    <td className="px-3 py-2 text-xs">{c.provider}</td>
                    <td className="px-3 py-2 font-mono text-xs">…{c.last_4}</td>
                    <td className="px-3 py-2">
                      <Badge>{c.status}</Badge>
                      {c.failure_count > 0 && (
                        <span className="text-xs text-red-600 ml-2">
                          {c.failure_count} failures
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-500">
                      {c.last_used_at ? new Date(c.last_used_at).toLocaleString() : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setDeletingId(c.id)}
                        className="text-red-600 hover:text-red-900"
                      >
                        <TrashIcon className="size-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium mb-2">Use-case pinned credentials</h2>
        {useCaseCreds.length === 0 ? (
          <div className="rounded-md border border-dashed p-10 text-center text-sm text-neutral-500">
            No use-case pinned credentials. Cron-driven use-cases fall back to system env vars.
          </div>
        ) : (
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50">
                <tr className="text-left">
                  <th className="px-3 py-2">Use-case</th>
                  <th className="px-3 py-2">Provider</th>
                  <th className="px-3 py-2">Key ending</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Last used</th>
                </tr>
              </thead>
              <tbody>
                {useCaseCreds.map((c) => (
                  <tr key={c.id} className="border-t hover:bg-neutral-50">
                    <td className="px-3 py-2 font-mono text-xs">{c.use_case}</td>
                    <td className="px-3 py-2 text-xs">{c.provider}</td>
                    <td className="px-3 py-2 font-mono text-xs">…{c.last_4}</td>
                    <td className="px-3 py-2">
                      <Badge>{c.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-500">
                      {c.last_used_at ? new Date(c.last_used_at).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {draft && (
        <Modal
          isOpen
          onClose={() => setDraft(null)}
          title="New user credential"
          size="md"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <Field label="User ID (uuid)">
              <input
                className="form-input w-full font-mono text-xs"
                value={draft.userId}
                onChange={(e) => setDraft({ ...draft, userId: e.target.value })}
                placeholder="ebc32e3d-…"
              />
            </Field>
            <Field label="Provider">
              <select
                className="form-input w-full"
                value={draft.provider}
                onChange={(e) => setDraft({ ...draft, provider: e.target.value as AiProvider })}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </Field>
            <Field label="API key">
              <input
                type="password"
                className="form-input w-full font-mono text-xs"
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                placeholder="sk-…"
              />
              <p className="text-xs text-neutral-500 mt-1">
                Stored encrypted via pgsodium. Only the last 4 characters are kept for
                operator disambiguation. The cleartext is never returned by the API.
              </p>
            </Field>
          </div>
        </Modal>
      )}

      <ConfirmModal
        show={Boolean(deletingId)}
        onClose={() => setDeletingId(null)}
        onConfirm={handleDelete}
        title="Delete credential"
        message="Permanently delete this credential? The user will fall back to the next-tier resolution (use-case pin → env var)."
        confirmText="Delete"
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
