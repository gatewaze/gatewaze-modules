/**
 * spec-ai-mcp-extensions.md §7.1 §7.2 — MCP server registry admin UI.
 *
 * v1 scope: list + add modal + enable/disable toggle + delete + Test
 * probe trigger. Per-server "debug chat" surface (§7.6) is feature-
 * flagged and not wired in this initial cut — operators reach it via
 * the use-case editor's Allowed MCP servers section once that lands.
 */

import { useEffect, useMemo, useState } from 'react';
import { TrashIcon } from '@heroicons/react/24/outline';
import { Button, IconButton } from '@/components/ui';
import { authedFetch } from '../utils/aiService';

interface McpServerStdio { cmd: string | null; args: string[]; env_keys: string[]; envs_set: boolean }
interface McpServerHttp  { uri: string | null; headers: Record<string, string>; bearer_token_set: boolean }
interface McpServerBuiltin { builtin_name: string | null }

interface McpServer {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  type: 'stdio' | 'streamable_http' | 'builtin';
  enabled: boolean;
  timeout_seconds: number;
  last_tested_at: string | null;
  last_tested_status: 'ok' | 'error' | null;
  last_tested_error: string | null;
  stdio: McpServerStdio | null;
  streamable_http: McpServerHttp | null;
  builtin: McpServerBuiltin | null;
  capabilities: { supports_bearer_token_injection: boolean; tool_call_capture: string };
}

type ServerType = McpServer['type'];

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, init);
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error?.message ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export default function AiMcpServersAdmin(): JSX.Element {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<McpServer | null>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const r = await jsonFetch<{ servers: McpServer[] }>('/api/modules/ai/admin/mcp-servers');
      setServers(r.servers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function onDelete(id: string, name: string): Promise<void> {
    if (!confirm(`Delete MCP server "${name}"? This fails if any use case still references it.`)) return;
    try {
      await jsonFetch(`/api/modules/ai/admin/mcp-servers/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function onToggleEnabled(srv: McpServer): Promise<void> {
    try {
      await jsonFetch(`/api/modules/ai/admin/mcp-servers/${srv.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !srv.enabled }),
      });
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function onTest(id: string): Promise<void> {
    try {
      const r = await jsonFetch<{ status: string; job_id: string }>(
        `/api/modules/ai/admin/mcp-servers/${id}/test`,
        { method: 'POST' },
      );
      alert(`Test queued (job ${r.job_id}). Check back in a few seconds — last_tested_at will update.`);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">MCP servers</h2>
          <p className="text-sm text-neutral-600">
            Registered MCP servers consumable by recipes + chat. Allowlist each server on the use case that needs it.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void refresh()} disabled={loading}>Refresh</Button>
          <Button onClick={() => setShowAdd(true)}>+ Add server</Button>
        </div>
      </div>

      {error && <div className="p-3 rounded border border-red-200 bg-red-50 text-red-700 text-sm">{error}</div>}

      {loading ? (
        <div className="text-neutral-500 text-sm">Loading…</div>
      ) : servers.length === 0 ? (
        <div className="p-6 rounded border border-neutral-200 bg-neutral-50 text-sm text-neutral-600">
          No MCP servers registered yet. Click <strong>+ Add server</strong> to register a stdio command (e.g. <code>uvx mcp-hn</code>), a streamable HTTP endpoint, or a Goose builtin.
        </div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-neutral-500 border-b border-neutral-200">
              <th className="py-2 pr-3">Name</th>
              <th className="py-2 pr-3">Type</th>
              <th className="py-2 pr-3">Spec</th>
              <th className="py-2 pr-3">Last test</th>
              <th className="py-2 pr-3 w-32">Enabled</th>
              <th className="py-2 pr-3 w-48">Actions</th>
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => (
              <tr key={s.id} className="border-b border-neutral-100">
                <td className="py-2 pr-3">
                  <div className="font-mono">{s.name}</div>
                  <div className="text-xs text-neutral-500">{s.display_name}</div>
                </td>
                <td className="py-2 pr-3"><code className="text-xs">{s.type}</code></td>
                <td className="py-2 pr-3 font-mono text-xs text-neutral-700">
                  {s.type === 'stdio' && s.stdio
                    ? `${s.stdio.cmd ?? ''} ${(s.stdio.args ?? []).join(' ')}`
                    : s.type === 'streamable_http' && s.streamable_http
                      ? s.streamable_http.uri
                      : s.type === 'builtin' && s.builtin
                        ? s.builtin.builtin_name
                        : '—'}
                </td>
                <td className="py-2 pr-3 text-xs">
                  {s.last_tested_at ? (
                    <span className={s.last_tested_status === 'ok' ? 'text-emerald-700' : 'text-red-700'}>
                      {s.last_tested_status === 'ok' ? '✓' : '✗'} {new Date(s.last_tested_at).toLocaleString()}
                    </span>
                  ) : <span className="text-neutral-400">never</span>}
                </td>
                <td className="py-2 pr-3">
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={() => void onToggleEnabled(s)}
                    />
                    <span className="text-xs">{s.enabled ? 'Enabled' : 'Disabled'}</span>
                  </label>
                </td>
                <td className="py-2 pr-3 flex gap-1">
                  <Button onClick={() => setEditing(s)}>Edit</Button>
                  <Button onClick={() => void onTest(s.id)}>Test</Button>
                  <IconButton aria-label="Delete" onClick={() => void onDelete(s.id, s.name)}>
                    <TrashIcon className="size-4" />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(showAdd || editing) && (
        <McpServerModal
          editing={editing}
          onClose={() => { setShowAdd(false); setEditing(null); }}
          onSaved={() => { setShowAdd(false); setEditing(null); void refresh(); }}
        />
      )}
    </div>
  );
}

interface ModalProps { editing: McpServer | null; onClose: () => void; onSaved: () => void }

function McpServerModal({ editing, onClose, onSaved }: ModalProps): JSX.Element {
  const isEdit = !!editing;
  const [type, setType] = useState<ServerType>(editing?.type ?? 'stdio');
  const [name, setName] = useState(editing?.name ?? '');
  const [displayName, setDisplayName] = useState(editing?.display_name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  // stdio fields
  const [cmd, setCmd] = useState(editing?.stdio?.cmd ?? 'uvx');
  const [argsRaw, setArgsRaw] = useState((editing?.stdio?.args ?? []).join(' '));
  const [envKeysRaw, setEnvKeysRaw] = useState((editing?.stdio?.env_keys ?? []).join(','));
  const [envsRaw, setEnvsRaw] = useState(''); // KEY=value lines (values never sent back down; blank keeps current)
  // streamable_http fields
  const [uri, setUri] = useState(editing?.streamable_http?.uri ?? '');
  const [bearerToken, setBearerToken] = useState(''); // blank on edit = keep current token
  // builtin
  const [builtinName, setBuiltinName] = useState(editing?.builtin?.builtin_name ?? 'memory');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedArgs = useMemo(() => argsRaw.split(/\s+/).filter((s) => s.length > 0), [argsRaw]);
  const parsedEnvKeys = useMemo(() => envKeysRaw.split(/[,\s]+/).filter((s) => s.length > 0), [envKeysRaw]);
  const parsedEnvs = useMemo(() => {
    const out: Record<string, string> = {};
    for (const line of envsRaw.split(/\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
    }
    return out;
  }, [envsRaw]);

  async function onSubmit(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      if (isEdit && editing) {
        // PATCH — name + type are immutable; a blank bearer/env keeps the
        // stored value (only sent when the operator typed a new one).
        const body: Record<string, unknown> = {
          display_name: displayName, description: description || null,
        };
        if (type === 'stdio') {
          body.stdio = { args: parsedArgs, env_keys: parsedEnvKeys, ...(Object.keys(parsedEnvs).length && { envs: parsedEnvs }) };
        } else if (type === 'streamable_http') {
          body.streamable_http = { uri, ...(bearerToken && { bearer_token: bearerToken }) };
        }
        await jsonFetch(`/api/modules/ai/admin/mcp-servers/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      } else {
        const body: Record<string, unknown> = {
          name, display_name: displayName, description: description || null, type, enabled: true,
        };
        if (type === 'stdio') {
          body.stdio = { cmd, args: parsedArgs, env_keys: parsedEnvKeys, envs: parsedEnvs };
        } else if (type === 'streamable_http') {
          body.streamable_http = { uri, headers: {}, ...(bearerToken && { bearer_token: bearerToken }) };
        } else {
          body.builtin = { builtin_name: builtinName };
        }
        await jsonFetch('/api/modules/ai/admin/mcp-servers', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-md p-6 max-w-2xl w-full space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">{isEdit ? 'Edit MCP server' : 'Add MCP server'}</h3>
          <IconButton aria-label="Close" onClick={onClose}>✕</IconButton>
        </div>

        {error && <div className="p-2 rounded border border-red-200 bg-red-50 text-red-700 text-sm">{error}</div>}

        <div className="flex gap-3 text-sm">
          {(['stdio', 'streamable_http', 'builtin'] as ServerType[]).map((t) => (
            <label key={t} className="inline-flex items-center gap-1">
              <input type="radio" name="srv-type" checked={type === t} onChange={() => setType(t)} disabled={isEdit} />
              <span className={isEdit && type !== t ? 'text-neutral-400' : ''}>{t}</span>
            </label>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="space-y-1">
            <div className="text-xs text-neutral-600">Name (kebab-case, immutable)</div>
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={isEdit} className="w-full border rounded px-2 py-1 font-mono disabled:bg-neutral-100 disabled:text-neutral-500" placeholder="hackernews" />
          </label>
          <label className="space-y-1">
            <div className="text-xs text-neutral-600">Display name</div>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="w-full border rounded px-2 py-1" placeholder="Hacker News" />
          </label>
        </div>

        <label className="space-y-1 block text-sm">
          <div className="text-xs text-neutral-600">Description (optional)</div>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="w-full border rounded px-2 py-1" />
        </label>

        {type === 'stdio' && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <div className="text-xs text-neutral-600">cmd (allowlist: uvx, npx)</div>
                <input value={cmd} onChange={(e) => setCmd(e.target.value)} className="w-full border rounded px-2 py-1 font-mono" />
              </label>
              <label className="space-y-1">
                <div className="text-xs text-neutral-600">args (space-separated)</div>
                <input value={argsRaw} onChange={(e) => setArgsRaw(e.target.value)} className="w-full border rounded px-2 py-1 font-mono" placeholder="mcp-hn" />
              </label>
            </div>
            <label className="space-y-1 block">
              <div className="text-xs text-neutral-600">env_keys (comma- or space-separated names — UPPER_SNAKE_CASE)</div>
              <input value={envKeysRaw} onChange={(e) => setEnvKeysRaw(e.target.value)} className="w-full border rounded px-2 py-1 font-mono" placeholder="BRAVE_API_KEY,GITHUB_TOKEN" />
            </label>
            <label className="space-y-1 block">
              <div className="text-xs text-neutral-600">env values (one KEY=value per line — encrypted at rest)</div>
              <textarea value={envsRaw} onChange={(e) => setEnvsRaw(e.target.value)} rows={4} className="w-full border rounded px-2 py-1 font-mono text-xs" />
            </label>
          </div>
        )}

        {type === 'streamable_http' && (
          <div className="space-y-3 text-sm">
            <label className="space-y-1 block">
              <div className="text-xs text-neutral-600">URI (https only)</div>
              <input value={uri} onChange={(e) => setUri(e.target.value)} className="w-full border rounded px-2 py-1 font-mono" placeholder="https://mcp.lfx.dev/mcp" />
            </label>
            <label className="space-y-1 block">
              <div className="text-xs text-neutral-600">
                Bearer token (optional — encrypted at rest){isEdit && editing?.streamable_http?.bearer_token_set ? ' — leave blank to keep current' : ''}
              </div>
              <input type="password" value={bearerToken} onChange={(e) => setBearerToken(e.target.value)} className="w-full border rounded px-2 py-1 font-mono" placeholder={isEdit && editing?.streamable_http?.bearer_token_set ? '•••••• (unchanged)' : ''} />
            </label>
          </div>
        )}

        {type === 'builtin' && (
          <label className="space-y-1 block text-sm">
            <div className="text-xs text-neutral-600">Goose builtin name</div>
            <input value={builtinName} onChange={(e) => setBuiltinName(e.target.value)} className="w-full border rounded px-2 py-1 font-mono" placeholder="memory" />
          </label>
        )}

        <div className="flex justify-end gap-2 pt-3">
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => void onSubmit()} disabled={saving || !name || !displayName}>
            {saving ? 'Saving…' : isEdit ? 'Save' : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  );
}
