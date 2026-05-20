/**
 * spec-ai-mcp-extensions.md §Memory backing store §Admin UI.
 *
 * /admin/ai/memory — operator inspector for ai_memory. Filter by use
 * case + optional scope/thread. Each row shows key, pretty-printed
 * value, scope, expiry, and a delete button (model rewrites on next
 * turn if it still needs the value).
 */

import { useEffect, useState } from 'react';
import { Button, IconButton } from '@/components/ui';

interface MemoryEntry {
  id: string;
  scope: 'thread' | 'use_case' | 'user';
  thread_id: string | null;
  user_id: string | null;
  key: string;
  value: unknown;
  expires_at: string | null;
  written_by_message_id: string | null;
  created_at: string;
  updated_at: string;
}

interface UseCaseRef { id: string; label: string }

export default function AiMemoryAdmin(): JSX.Element {
  const [useCases, setUseCases] = useState<UseCaseRef[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [scope, setScope] = useState<string>('');
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/modules/ai/admin/use-cases', { credentials: 'include' });
        const j = await r.json();
        const cases = ((j.use_cases ?? j.useCases ?? []) as Array<{ id: string; label: string }>);
        setUseCases(cases);
        if (cases.length > 0 && !selected) setSelected(cases[0].id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => {
    if (!selected) return;
    void refresh();
  }, [selected, scope]);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const url = new URL('/api/modules/ai/admin/memory', window.location.origin);
      url.searchParams.set('use_case', selected);
      if (scope) url.searchParams.set('scope', scope);
      const r = await fetch(url.pathname + url.search, { credentials: 'include' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message ?? r.statusText);
      setEntries(j.entries ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onDelete(id: string, key: string): Promise<void> {
    if (!confirm(`Delete memory entry "${key}"? The model can rewrite it on the next turn.`)) return;
    try {
      const r = await fetch(`/api/modules/ai/admin/memory/${id}`, { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error(await r.text());
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Memory</h2>
        <p className="text-sm text-neutral-600">
          Gatewaze-owned backing store for the substituted <code>memory</code> MCP server. Entries the model has stored via <code>store_memory</code> + their scope, TTL, and originating message.
        </p>
      </div>

      <div className="flex gap-3 items-end">
        <label className="flex-1 space-y-1 text-sm">
          <div className="text-xs text-neutral-600">Use case</div>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="w-full border rounded px-2 py-1 font-mono"
          >
            {useCases.map((u) => (
              <option key={u.id} value={u.id}>{u.id} — {u.label}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <div className="text-xs text-neutral-600">Scope</div>
          <select value={scope} onChange={(e) => setScope(e.target.value)} className="border rounded px-2 py-1">
            <option value="">all</option>
            <option value="thread">thread</option>
            <option value="use_case">use_case</option>
            <option value="user">user</option>
          </select>
        </label>
        <Button onClick={() => void refresh()} disabled={loading}>Refresh</Button>
      </div>

      {error && <div className="p-3 rounded border border-red-200 bg-red-50 text-red-700 text-sm">{error}</div>}

      {loading ? (
        <div className="text-neutral-500 text-sm">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="p-6 rounded border border-neutral-200 bg-neutral-50 text-sm text-neutral-600">
          No memory entries for this filter. The model hasn't written any yet, or all entries have expired.
        </div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-neutral-500 border-b border-neutral-200">
              <th className="py-2 pr-3 w-48">Key</th>
              <th className="py-2 pr-3 w-24">Scope</th>
              <th className="py-2 pr-3">Value</th>
              <th className="py-2 pr-3 w-32">Updated</th>
              <th className="py-2 pr-3 w-32">Expires</th>
              <th className="py-2 pr-3 w-12"></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-neutral-100 align-top">
                <td className="py-2 pr-3 font-mono text-xs break-all">{e.key}</td>
                <td className="py-2 pr-3 text-xs">
                  <code>{e.scope}</code>
                  {e.thread_id && <div className="text-neutral-500 truncate" title={e.thread_id}>thread {e.thread_id.slice(0, 8)}</div>}
                </td>
                <td className="py-2 pr-3">
                  <pre className="text-xs whitespace-pre-wrap break-words bg-neutral-50 p-2 rounded border border-neutral-200 max-h-32 overflow-y-auto">
                    {typeof e.value === 'string' ? e.value : JSON.stringify(e.value, null, 2)}
                  </pre>
                </td>
                <td className="py-2 pr-3 text-xs text-neutral-500">{new Date(e.updated_at).toLocaleString()}</td>
                <td className="py-2 pr-3 text-xs text-neutral-500">
                  {e.expires_at ? new Date(e.expires_at).toLocaleString() : <span className="text-neutral-400">never</span>}
                </td>
                <td className="py-2 pr-3">
                  <IconButton aria-label="Delete" onClick={() => void onDelete(e.id, e.key)}>🗑</IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
