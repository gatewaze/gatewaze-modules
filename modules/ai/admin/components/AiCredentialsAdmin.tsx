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
import { AdminUserService } from '@/utils/adminUserService';
import type { AdminUser } from '@/lib/supabase';

import {
  createUseCaseCredential,
  createUserCredential,
  deleteUseCaseCredential,
  deleteUserCredential,
  listCredentials,
  listUseCases,
  type AiProvider,
  type AiUseCase,
  type AiUseCaseCredentialMeta,
  type AiUserCredentialMeta,
} from '../utils/aiService';

interface NewUserCredentialDraft {
  kind: 'user';
  userId: string;
  provider: AiProvider;
  apiKey: string;
}

interface NewUseCaseCredentialDraft {
  kind: 'use-case';
  useCase: string;
  provider: AiProvider;
  apiKey: string;
}

type NewCredentialDraft = NewUserCredentialDraft | NewUseCaseCredentialDraft;

const PROVIDERS: AiProvider[] = ['openai', 'anthropic', 'gemini'];

export default function AiCredentialsAdmin() {
  const [userCreds, setUserCreds] = useState<AiUserCredentialMeta[]>([]);
  const [useCaseCreds, setUseCaseCreds] = useState<AiUseCaseCredentialMeta[]>([]);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [useCases, setUseCases] = useState<AiUseCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<NewCredentialDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<{ kind: 'user' | 'use-case'; id: string } | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [credResult, userResult, useCaseRows] = await Promise.all([
        listCredentials(),
        AdminUserService.getAllUsers(),
        listUseCases(),
      ]);
      setUserCreds(credResult.user_credentials);
      setUseCaseCreds(credResult.use_case_credentials);
      const activeUsers = (userResult.users ?? []).filter((u) => u.is_active !== false);
      setAdminUsers(activeUsers);
      setUseCases(useCaseRows);
    } catch (err) {
      console.error('[ai-credentials] load failed', err);
      toast.error('Failed to load credentials');
    } finally {
      setLoading(false);
    }
  }

  // Map user_id → admin profile for table-row labelling.
  const adminUserById = new Map(adminUsers.map((u) => [u.id, u]));

  async function handleSave() {
    if (!draft) return;
    if (!draft.apiKey.trim()) {
      toast.error('API key is required');
      return;
    }
    if (draft.kind === 'user' && !draft.userId.trim()) {
      toast.error('User is required');
      return;
    }
    if (draft.kind === 'use-case' && !draft.useCase.trim()) {
      toast.error('Use-case is required');
      return;
    }
    setSaving(true);
    try {
      if (draft.kind === 'user') {
        const result = await createUserCredential({
          userId: draft.userId.trim(),
          provider: draft.provider,
          apiKey: draft.apiKey.trim(),
        });
        toast.success(`Credential created (ending …${result.last_4})`);
      } else {
        const result = await createUseCaseCredential({
          useCase: draft.useCase.trim(),
          provider: draft.provider,
          apiKey: draft.apiKey.trim(),
        });
        toast.success(`Credential created (ending …${result.last_4})`);
      }
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
    if (!deleting) return;
    try {
      if (deleting.kind === 'user') await deleteUserCredential(deleting.id);
      else await deleteUseCaseCredential(deleting.id);
      toast.success('Credential deleted');
      setDeleting(null);
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
    <div className="space-y-6">
      <p className="text-sm text-neutral-500">
        API keys at two scopes. The provider router resolves keys in order:
        per-user override (operator's own key) → use-case pin (cron-driven runs
        and shared automation) → system env var.
      </p>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium">User credentials</h2>
          <Button
            size="sm"
            onClick={() =>
              setDraft({ kind: 'user', userId: '', provider: 'anthropic', apiKey: '' })
            }
          >
            <PlusIcon className="size-4 mr-1" />
            Add user credential
          </Button>
        </div>
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
                {userCreds.map((c) => {
                  const user = adminUserById.get(c.user_id);
                  return (
                  <tr key={c.id} className="border-t hover:bg-neutral-50">
                    <td className="px-3 py-2 text-xs">
                      {user ? (
                        <>
                          <div className="font-medium">{user.name || user.email}</div>
                          {user.name && <div className="text-neutral-500">{user.email}</div>}
                        </>
                      ) : (
                        <span className="font-mono text-neutral-500" title={c.user_id}>
                          {c.user_id.slice(0, 8)}…
                        </span>
                      )}
                    </td>
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
                        onClick={() => setDeleting({ kind: 'user', id: c.id })}
                        className="text-red-600 hover:text-red-900"
                      >
                        <TrashIcon className="size-4" />
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium">Use-case pinned credentials</h2>
          <Button
            size="sm"
            onClick={() =>
              setDraft({
                kind: 'use-case',
                useCase: useCases[0]?.id ?? '',
                provider: 'anthropic',
                apiKey: '',
              })
            }
          >
            <PlusIcon className="size-4 mr-1" />
            Add use-case credential
          </Button>
        </div>
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
                  <th className="px-3 py-2 w-12"></th>
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
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setDeleting({ kind: 'use-case', id: c.id })}
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

      {draft && (
        <Modal
          isOpen
          onClose={() => setDraft(null)}
          title={draft.kind === 'user' ? 'New user credential' : 'New use-case credential'}
          size="md"
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
            {draft.kind === 'user' ? (
              <Field label="User">
                <select
                  className="form-input w-full"
                  value={draft.userId}
                  onChange={(e) => setDraft({ ...draft, userId: e.target.value })}
                >
                  <option value="">Select an admin user…</option>
                  {adminUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name ? `${u.name} (${u.email})` : u.email}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="Use-case">
                <select
                  className="form-input w-full"
                  value={draft.useCase}
                  onChange={(e) => setDraft({ ...draft, useCase: e.target.value })}
                >
                  <option value="">Select a use-case…</option>
                  {useCases.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.label} ({u.id})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-neutral-500 mt-1">
                  Pins this provider key to the use-case. Cron-driven use-cases (autopilots
                  without a logged-in operator) will pick this up via the credential router.
                </p>
              </Field>
            )}
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
        show={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title="Delete credential"
        message={
          deleting?.kind === 'use-case'
            ? 'Permanently delete this use-case credential? The use-case will fall back to the system env var on the next call.'
            : 'Permanently delete this credential? The user will fall back to the next-tier resolution (use-case pin → env var).'
        }
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
