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
import { Badge, Button, Card } from '@/components/ui';
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
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-[var(--gray-a2)]"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Badge color={s.status === 'active' ? 'success' : s.status === 'errored' ? 'error' : 'neutral'}>
                      {s.kind}
                    </Badge>
                    <span className="text-sm font-medium text-[var(--gray-12)] truncate">{s.label}</span>
                    {s.url && (
                      <span className="text-xs text-[var(--gray-a8)] font-mono truncate">{s.url}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-[var(--gray-a8)] shrink-0">
                    {s.installed_git_sha && (
                      <span className="font-mono">{s.installed_git_sha.slice(0, 7)}</span>
                    )}
                    {s.available_git_sha && s.available_git_sha !== s.installed_git_sha && (
                      <Badge color="warning">drift</Badge>
                    )}
                    {s.last_check_error && <Badge color="error">error</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
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
