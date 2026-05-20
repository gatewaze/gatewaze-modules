/**
 * AI Agent Sources — admin page for managing git-driven skill repos.
 *
 * Per spec-ai-skills.md §8.1.
 *
 *   - List existing sources with sync status + last-synced time
 *   - Add a new source (modal: label, git URL, branch, path prefix,
 *     optional auth token, webhook provider)
 *   - Sync now button per row
 *   - Show webhook URL + secret (with provider-specific instructions)
 *   - Test connection (runs `git ls-remote` synchronously)
 *   - Rotate webhook secret
 *   - Recent webhook events panel
 *
 * Reachable from the Modules admin page (registered via the manifest's
 * `adminNavItems`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Card, Button } from '@/components/ui';
import { ArrowPathIcon, PlusIcon, TrashIcon, EyeIcon, KeyIcon } from '@heroicons/react/24/outline';
import { AgentsService, type AgentSource, type WebhookLogEntry } from '../utils/agentsService';

const STATUS_COLORS: Record<AgentSource['sync_status'], string> = {
  pending: 'text-[var(--gray-9)]',
  syncing: 'text-blue-500',
  ok: 'text-green-600',
  error: 'text-red-600',
};

const STATUS_LABELS: Record<AgentSource['sync_status'], string> = {
  pending: 'Pending',
  syncing: 'Syncing…',
  ok: 'OK',
  error: 'Error',
};

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'in the future';
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

export default function AgentSourcesPage() {
  const [sources, setSources] = useState<AgentSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    setLoading(true);
    const r = await AgentsService.listSources();
    setLoading(false);
    if (!r.ok) {
      toast.error(`Failed to load sources: ${r.error.message}`);
      return;
    }
    setSources(r.value);
  }, []);

  useEffect(() => {
    void loadSources();
    // Poll every 30 s so sync status flips to OK visibly when the worker finishes.
    const t = setInterval(() => void loadSources(), 30_000);
    return () => clearInterval(t);
  }, [loadSources]);

  return (
    <Page title="AI Agent Sources">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold">AI Agent Sources</h2>
          <p className="text-sm text-[var(--gray-9)] mt-1">
            Git repositories containing markdown skill files that shape AI-generated newsletters and pages.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void loadSources()}>
            <ArrowPathIcon className="w-4 h-4" /> Refresh
          </Button>
          <Button onClick={() => setAddOpen(true)}>
            <PlusIcon className="w-4 h-4" /> Add Source
          </Button>
        </div>
      </div>

      {loading && <div className="flex justify-center py-12"><LoadingSpinner /></div>}

      {!loading && sources.length === 0 && (
        <Card className="p-8 text-center text-[var(--gray-9)]">
          <p className="mb-3">No agent sources yet.</p>
          <p className="text-sm">
            Add a git repository containing your AI brand-voice / structural guidelines as markdown files.
            They'll apply to every AI generation that selects them in its newsletter or site settings.
          </p>
        </Card>
      )}

      {!loading && sources.map((src) => (
        <SourceRow
          key={src.id}
          source={src}
          expanded={expandedId === src.id}
          onToggleExpanded={() => setExpandedId((cur) => (cur === src.id ? null : src.id))}
          onChanged={() => void loadSources()}
        />
      ))}

      {addOpen && (
        <AddSourceModal
          onClose={() => setAddOpen(false)}
          onCreated={() => {
            setAddOpen(false);
            void loadSources();
          }}
        />
      )}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Source row
// ---------------------------------------------------------------------------

function SourceRow({
  source,
  expanded,
  onToggleExpanded,
  onChanged,
}: {
  source: AgentSource;
  expanded: boolean;
  onToggleExpanded: () => void;
  onChanged: () => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  const webhookUrl = useMemo(() => {
    const apiUrl = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
    return `${apiUrl}/api/modules/ai/admin/agent-sources/${source.id}/webhook`;
  }, [source.id]);

  async function handleSync() {
    setSyncing(true);
    const r = await AgentsService.syncNow(source.id);
    setSyncing(false);
    if (!r.ok) {
      toast.error(`Sync failed: ${r.error.message}`);
      return;
    }
    toast.success('Sync queued — refreshing in a few seconds…');
    setTimeout(onChanged, 5000);
  }

  async function handleTest() {
    const r = await AgentsService.testConnection(source.id);
    if (!r.ok) {
      toast.error(`Test failed: ${r.error.message}`);
      return;
    }
    const v = r.value;
    if (v.ok) toast.success(`Connection OK (HEAD: ${v.head_sha.slice(0, 7)})`);
    else toast.error(`Connection failed: ${v.error}`);
  }

  async function handleDelete() {
    const confirmed = window.confirm(
      `Delete source "${source.label}"? Cascade-deletes all indexed skills from this repo. Newsletters/sites currently using these skills will silently skip them on next generation.`,
    );
    if (!confirmed) return;
    const r = await AgentsService.deleteSource(source.id);
    if (!r.ok) {
      toast.error(`Delete failed: ${r.error.message}`);
      return;
    }
    toast.success(`Deleted (${r.value.cascaded_skill_count} skills cascaded)`);
    onChanged();
  }

  return (
    <Card className="mb-3 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <button
              type="button"
              onClick={onToggleExpanded}
              className="font-semibold text-left hover:underline"
            >
              {expanded ? '▾' : '▸'} {source.label}
            </button>
            <span className={`text-xs ${STATUS_COLORS[source.sync_status]}`}>
              {STATUS_LABELS[source.sync_status]}
              {source.sync_status === 'error' && source.sync_error ? ` — ${source.sync_error}` : ''}
            </span>
          </div>
          <div className="text-xs text-[var(--gray-9)] font-mono break-all">
            {source.git_url} · {source.branch}
            {source.path_prefix ? ` · /${source.path_prefix}` : ''}
          </div>
          <div className="text-xs text-[var(--gray-9)] mt-1">
            Last synced: {timeAgo(source.last_synced_at)}
            {source.last_synced_commit ? ` · @${source.last_synced_commit.slice(0, 7)}` : ''}
          </div>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <Button onClick={() => void handleSync()} disabled={syncing}>
            <ArrowPathIcon className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Queued…' : 'Sync now'}
          </Button>
          <Button onClick={() => void handleTest()}>Test</Button>
          <Button onClick={handleDelete}>
            <TrashIcon className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 pt-4 border-t border-[var(--gray-6)] grid gap-4">
          <WebhookSection source={source} url={webhookUrl} showSecret={showSecret} onToggleSecret={() => setShowSecret((s) => !s)} onRotated={onChanged} />
          <WebhookLogSection sourceId={source.id} />
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Webhook section
// ---------------------------------------------------------------------------

function WebhookSection({
  source,
  url,
  showSecret,
  onToggleSecret,
  onRotated,
}: {
  source: AgentSource;
  url: string;
  showSecret: boolean;
  onToggleSecret: () => void;
  onRotated: () => void;
}) {
  const [secret, setSecret] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);

  async function handleRotate() {
    const confirmed = window.confirm('Rotate the webhook secret? The old secret stops working immediately.');
    if (!confirmed) return;
    setRotating(true);
    const r = await AgentsService.rotateWebhookSecret(source.id);
    setRotating(false);
    if (!r.ok) {
      toast.error(`Rotate failed: ${r.error.message}`);
      return;
    }
    setSecret(r.value.webhook_secret);
    toast.success('Webhook secret rotated');
    onRotated();
  }

  return (
    <div>
      <h3 className="font-medium text-sm mb-2 flex items-center gap-2">
        <KeyIcon className="w-4 h-4" /> Webhook
      </h3>
      <p className="text-xs text-[var(--gray-9)] mb-2">
        Configure this in your {source.webhook_provider} repo settings to trigger instant sync on push (instead of waiting up to 5 minutes for the cron).
      </p>
      <div className="text-xs space-y-1">
        <div><strong>URL:</strong> <code className="break-all">{url}</code></div>
        <div>
          <strong>Secret:</strong>{' '}
          {secret ? (
            <code className="break-all bg-[var(--gray-3)] px-2 py-1 rounded">{secret}</code>
          ) : showSecret ? (
            <em className="text-[var(--gray-9)]">stored encrypted — rotate to reveal a new one</em>
          ) : (
            <Button onClick={onToggleSecret}><EyeIcon className="w-3 h-3" /> Show…</Button>
          )}
        </div>
        <div className="pt-1">
          <Button onClick={() => void handleRotate()} disabled={rotating}>
            {rotating ? 'Rotating…' : 'Rotate secret'}
          </Button>
        </div>
        <div className="pt-2 text-[var(--gray-9)]">
          <strong>Provider config:</strong>{' '}
          {source.webhook_provider === 'github' && (
            <>GitHub: Settings → Webhooks → Add. Payload URL: <em>(above)</em>. Content type: <code>application/json</code>. Secret: <em>(above, after rotate)</em>. Events: just <code>push</code>.</>
          )}
          {source.webhook_provider === 'gitlab' && (
            <>GitLab: Settings → Webhooks → Add. URL: <em>(above)</em>. Secret token: <em>(above, after rotate)</em>. Triggers: <code>Push events</code> only.</>
          )}
          {source.webhook_provider === 'gitea' && (
            <>Gitea: Settings → Webhooks → Add Webhook. URL: <em>(above)</em>. Secret: <em>(above, after rotate)</em>. Trigger: <code>Push Events</code>.</>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Webhook log section
// ---------------------------------------------------------------------------

function WebhookLogSection({ sourceId }: { sourceId: string }) {
  const [events, setEvents] = useState<WebhookLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await AgentsService.listWebhookLog(sourceId, 20);
      if (cancelled) return;
      setLoading(false);
      if (r.ok) setEvents(r.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  return (
    <div>
      <h3 className="font-medium text-sm mb-2">Recent webhook events</h3>
      {loading && <div className="text-xs text-[var(--gray-9)]">Loading…</div>}
      {!loading && events.length === 0 && (
        <div className="text-xs text-[var(--gray-9)]">No webhook events yet. Configure your repo's webhook and push to trigger an instant sync.</div>
      )}
      {!loading && events.length > 0 && (
        <div className="text-xs space-y-1 font-mono">
          {events.map((e) => (
            <div key={e.id} className="grid grid-cols-[140px_80px_60px_1fr] gap-2">
              <span className="text-[var(--gray-9)]">{new Date(e.received_at).toLocaleTimeString()}</span>
              <span>{e.provider}</span>
              <span className={e.status === 'queued' ? 'text-green-600' : e.status === 'ignored' ? 'text-[var(--gray-9)]' : 'text-red-600'}>
                {e.status}
              </span>
              <span className="truncate">{e.event_type ?? '—'} {e.status_reason ? `(${e.status_reason})` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add source modal
// ---------------------------------------------------------------------------

function AddSourceModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [label, setLabel] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [pathPrefix, setPathPrefix] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [provider, setProvider] = useState<'github' | 'gitlab' | 'gitea'>('github');
  const [submitting, setSubmitting] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim() || !gitUrl.trim()) {
      toast.error('Label and git URL are required');
      return;
    }
    if (!gitUrl.startsWith('https://')) {
      toast.error('git URL must start with https://');
      return;
    }
    setSubmitting(true);
    const r = await AgentsService.createSource({
      label: label.trim(),
      git_url: gitUrl.trim(),
      branch: branch.trim() || 'main',
      path_prefix: pathPrefix.trim(),
      ...(authToken.trim() ? { auth_token: authToken.trim() } : {}),
      webhook_provider: provider,
    });
    setSubmitting(false);
    if (!r.ok) {
      toast.error(`Create failed: ${r.error.message}`);
      return;
    }
    setCreatedSecret(r.value.webhook_secret);
    toast.success(`Created "${r.value.label}"`);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <Card className="w-full max-w-md p-6 bg-[var(--gray-1)]">
        {!createdSecret ? (
          <>
            <h3 className="font-semibold mb-4">Add Skill Source</h3>
            <form onSubmit={handleSubmit} className="space-y-3 text-sm">
              <label className="block">
                <span className="block mb-1 font-medium">Label</span>
                <input value={label} onChange={(e) => setLabel(e.target.value)} className="w-full px-3 py-2 border border-[var(--gray-6)] rounded" placeholder="Corporate brand voice" required />
              </label>
              <label className="block">
                <span className="block mb-1 font-medium">Git URL (https only)</span>
                <input value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} className="w-full px-3 py-2 border border-[var(--gray-6)] rounded font-mono text-xs" placeholder="https://github.com/org/skills.git" required />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="block mb-1 font-medium">Branch</span>
                  <input value={branch} onChange={(e) => setBranch(e.target.value)} className="w-full px-3 py-2 border border-[var(--gray-6)] rounded" placeholder="main" />
                </label>
                <label className="block">
                  <span className="block mb-1 font-medium">Path prefix</span>
                  <input value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} className="w-full px-3 py-2 border border-[var(--gray-6)] rounded" placeholder="skills" />
                </label>
              </div>
              <label className="block">
                <span className="block mb-1 font-medium">Auth token (private repos)</span>
                <input value={authToken} onChange={(e) => setAuthToken(e.target.value)} type="password" autoComplete="off" className="w-full px-3 py-2 border border-[var(--gray-6)] rounded" placeholder="github_pat_…" />
                <span className="block mt-1 text-xs text-[var(--gray-9)]">Stored encrypted. Leave blank for public repos.</span>
              </label>
              <label className="block">
                <span className="block mb-1 font-medium">Webhook provider</span>
                <select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)} className="w-full px-3 py-2 border border-[var(--gray-6)] rounded">
                  <option value="github">GitHub</option>
                  <option value="gitlab">GitLab</option>
                  <option value="gitea">Gitea</option>
                </select>
              </label>
              <div className="flex justify-end gap-2 pt-3">
                <Button onClick={onClose} type="button">Cancel</Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? 'Creating…' : 'Create'}
                </Button>
              </div>
            </form>
          </>
        ) : (
          <>
            <h3 className="font-semibold mb-2">Source created</h3>
            <p className="text-sm text-[var(--gray-9)] mb-3">
              Save this webhook secret — it's shown once. You can rotate it later.
            </p>
            <code className="block break-all text-xs p-3 bg-[var(--gray-3)] rounded mb-4">{createdSecret}</code>
            <div className="flex justify-end">
              <Button onClick={onCreated}>Done</Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
