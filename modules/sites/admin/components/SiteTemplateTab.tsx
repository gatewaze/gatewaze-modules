/**
 * Template tab — manages the site's bound templates_library and the git
 * source that feeds it.
 *
 * Shows:
 *   - Current library binding (name, theme_kind, last source_sha)
 *   - "Connect a git source" / "Re-ingest now" actions when bound
 *   - Source-ingest history (last N pulls + drift status)
 *   - "Pick a different library" swap action
 *
 * For the seeded Portal site, the tab is read-only (Portal renders
 * hand-written React, not schema-driven content) — see PortalTemplateView.
 */

import { useEffect, useState } from 'react';
import { ArrowPathIcon, KeyIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Badge, Button, Card, Input, Modal } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import type { SiteRow } from '../../types';

interface LibrarySummary {
  id: string;
  name: string;
  description: string | null;
  theme_kind: string;
  created_at: string;
}

interface SourceSummary {
  id: string;
  kind: 'git' | 'upload' | 'inline';
  label: string;
  status: 'active' | 'paused' | 'errored';
  url: string | null;
  branch: string | null;
  installed_git_sha: string | null;
  available_git_sha: string | null;
  last_checked_at: string | null;
  last_check_error: string | null;
}

export function SiteTemplateTab({
  site,
  onSiteUpdated: _onSiteUpdated,
}: {
  site: SiteRow;
  onSiteUpdated: (s: SiteRow) => void;
}) {
  const [library, setLibrary] = useState<LibrarySummary | null>(null);
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const isPortalSite = site.publishing_target.kind === 'portal' && site.slug === 'portal';

  useEffect(() => {
    if (isPortalSite) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      if (!site.templates_library_id) {
        if (!cancelled) {
          setLibrary(null);
          setSources([]);
          setLoading(false);
        }
        return;
      }
      const [libRes, srcRes] = await Promise.all([
        supabase
          .from('templates_libraries')
          .select('id, name, description, theme_kind, created_at')
          .eq('id', site.templates_library_id)
          .maybeSingle<LibrarySummary>(),
        supabase
          .from('templates_sources')
          .select('id, kind, label, status, url, branch, installed_git_sha, available_git_sha, last_checked_at, last_check_error')
          .eq('library_id', site.templates_library_id)
          .order('created_at', { ascending: false }),
      ]);
      if (cancelled) return;
      setLibrary(libRes.data ?? null);
      setSources((srcRes.data ?? []) as SourceSummary[]);
      setLoading(false);
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [site.templates_library_id, isPortalSite]);

  if (isPortalSite) {
    return <PortalTemplateView />;
  }

  if (loading) {
    return (
      <Card>
        <div className="p-6 text-sm text-[var(--gray-a8)]">Loading template binding…</div>
      </Card>
    );
  }

  if (!library) {
    return (
      <Card>
        <div className="p-6 space-y-3 text-sm">
          <h3 className="text-base font-semibold text-[var(--gray-12)]">No template library bound</h3>
          <p className="text-[var(--gray-a8)]">
            This site doesn't have a templates library yet. Use the Pages tab to provision a starter
            library, or bind an existing library here once swap is implemented.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="p-5 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-[var(--gray-12)]">{library.name}</h3>
              {library.description && (
                <p className="mt-1 text-sm text-[var(--gray-a8)]">{library.description}</p>
              )}
            </div>
            <Badge color={library.theme_kind === 'website' ? 'info' : 'neutral'}>
              {library.theme_kind}
            </Badge>
          </div>
          <div className="text-xs text-[var(--gray-a8)] flex items-center gap-3 pt-1">
            <span className="font-mono">{library.id}</span>
            <span>·</span>
            <span>created {new Date(library.created_at).toLocaleDateString()}</span>
          </div>
        </div>
      </Card>

      <Card>
        <div className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-[var(--gray-12)]">Sources</h3>
            <Button size="sm" variant="outlined" disabled>
              + Connect git source
            </Button>
          </div>
          {sources.length === 0 ? (
            <p className="text-sm text-[var(--gray-a8)]">
              No sources connected. Connect a git repo to ingest theme content schemas and block
              definitions automatically.
            </p>
          ) : (
            <ul className="space-y-2">
              {sources.map((s) => (
                <SourceRow key={s.id} source={s} siteId={site.id} onChanged={() => {
                  // Re-fetch sources after a refresh / rotate. Cheaper than
                  // full panel reload; keeps the library card stable.
                  if (!site.templates_library_id) return;
                  supabase
                    .from('templates_sources')
                    .select('id, kind, label, status, url, branch, installed_git_sha, available_git_sha, last_checked_at, last_check_error')
                    .eq('library_id', site.templates_library_id)
                    .order('created_at', { ascending: false })
                    .then((r) => setSources(((r.data ?? []) as unknown) as SourceSummary[]));
                }} />
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

function SourceRow({
  source,
  siteId,
  onChanged,
}: {
  source: SourceSummary;
  siteId: string;
  onChanged: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [showRotate, setShowRotate] = useState(false);
  const [newPat, setNewPat] = useState('');
  const [rotating, setRotating] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const res = await fetch(
        `${apiUrl}/api/modules/sites/admin/sites/${siteId}/source/${source.id}/refresh-git`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body?.error?.message ?? `Refresh failed (${res.status})`);
        return;
      }
      toast.success(`Pulled ${body.mainSha?.slice(0, 7)} on ${body.branch} → schema v${body.schemaVersion}`);
      onChanged();
    } finally {
      setRefreshing(false);
    }
  };

  const handleRotate = async () => {
    if (!newPat.trim()) {
      toast.error('PAT required');
      return;
    }
    setRotating(true);
    try {
      const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const secretKey = `git_pat_${source.id.replace(/-/g, '_').slice(0, 50)}`;
      const res = await fetch(`${apiUrl}/api/modules/sites/admin/sites/${siteId}/secrets`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ key: secretKey, values: { pat: newPat.trim() } }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body?.error?.message ?? `Rotate failed (${res.status})`);
        return;
      }
      toast.success('PAT rotated. Next refresh will use the new token.');
      setShowRotate(false);
      setNewPat('');
    } finally {
      setRotating(false);
    }
  };

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-[var(--gray-a2)]">
      <div className="flex items-center gap-3 min-w-0">
        <Badge color={source.status === 'active' ? 'success' : source.status === 'errored' ? 'error' : 'neutral'}>
          {source.kind}
        </Badge>
        <span className="text-sm font-medium text-[var(--gray-12)] truncate">{source.label}</span>
        {source.url && (
          <span className="text-xs text-[var(--gray-a8)] font-mono truncate">{source.url}</span>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-[var(--gray-a8)] shrink-0">
        {source.installed_git_sha && (
          <span className="font-mono">{source.installed_git_sha.slice(0, 7)}</span>
        )}
        {source.available_git_sha && source.available_git_sha !== source.installed_git_sha && (
          <Badge color="warning">drift</Badge>
        )}
        {source.last_check_error && <Badge color="error">error</Badge>}
        {source.kind === 'git' && (
          <>
            <Button size="sm" variant="ghost" onClick={handleRefresh} disabled={refreshing} title="Pull latest from upstream">
              <ArrowPathIcon className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowRotate(true)} title="Rotate PAT">
              <KeyIcon className="size-4" />
            </Button>
          </>
        )}
      </div>

      <Modal
        isOpen={showRotate}
        onClose={() => { setShowRotate(false); setNewPat(''); }}
        title="Rotate PAT"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outlined" onClick={() => { setShowRotate(false); setNewPat(''); }} disabled={rotating}>
              Cancel
            </Button>
            <Button onClick={handleRotate} disabled={rotating}>
              {rotating ? 'Saving…' : 'Rotate'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-[var(--gray-a8)]">
            Replaces the stored PAT for <span className="font-mono">{source.label}</span>. The new
            token is encrypted and used for the next refresh / pull.
          </p>
          <Input
            label="New PAT"
            type="password"
            placeholder="github_pat_..."
            value={newPat}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewPat(e.target.value)}
          />
        </div>
      </Modal>
    </li>
  );
}

// Read-only view for the seeded Portal site.
function PortalTemplateView() {
  return (
    <Card>
      <div className="p-6 space-y-2 text-sm">
        <h3 className="text-base font-semibold text-[var(--gray-12)]">Portal has no template library</h3>
        <p className="text-[var(--gray-a8)]">
          The Portal site renders hand-written React from the portal Next.js app, so it doesn't
          consume a templates_library. Custom sites bind a library here that supplies block
          definitions or content schemas, but the Portal's content is the application code itself.
        </p>
      </div>
    </Card>
  );
}
