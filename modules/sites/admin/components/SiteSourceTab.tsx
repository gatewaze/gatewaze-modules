/**
 * Source tab — git repo + templates library binding for the site.
 *
 * Per spec-content-modules-git-architecture §7.1:
 *   - Git provenance (internal vs external)
 *   - Current `main` HEAD SHA + drift status (commits ahead vs publish)
 *   - "Apply theme update" button (when drift detected)
 *   - "Graduate to external git" action (when internal)
 *   - Templates library binding (existing SiteTemplateTab content)
 *
 * The templates-library config from the legacy "Template" tab is rendered
 * below the git section.
 */

import { useEffect, useState } from 'react';
import { Badge, Button, Card } from '@/components/ui';
import { ArrowsRightLeftIcon, ArrowUpTrayIcon, CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import type { SiteRow } from '../../types';
import { SiteTemplateTab } from './SiteTemplateTab';

interface DriftStatus {
  commitsAhead: number;
  blockSchemaChanges: number;
  hasConflicts: boolean;
  mainHeadSha: string | null;
  publishHeadSha: string | null;
  lastFetchedAt: string | null;
}

interface SiteSourceTabProps {
  site: SiteRow & { git_provenance?: 'internal' | 'external'; git_url?: string | null };
  onSiteUpdated: (updated: SiteRow) => void;
}

export function SiteSourceTab({ site, onSiteUpdated }: SiteSourceTabProps) {
  const [drift, setDrift] = useState<DriftStatus | null>(null);
  const [loadingDrift, setLoadingDrift] = useState(true);
  const [applying, setApplying] = useState(false);

  const provenance = site.git_provenance ?? 'internal';
  const gitUrl = site.git_url ?? `(internal: ${site.slug}.git)`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingDrift(true);
      // GET /api/sites/:id/drift — see spec §22.1
      try {
        const resp = await fetch(`/api/sites/${site.id}/drift`);
        if (resp.ok && !cancelled) {
          setDrift(await resp.json());
        }
      } catch (err) {
        // Drift endpoint not yet wired up — show a placeholder
        if (!cancelled) {
          setDrift({
            commitsAhead: 0,
            blockSchemaChanges: 0,
            hasConflicts: false,
            mainHeadSha: null,
            publishHeadSha: null,
            lastFetchedAt: null,
          });
        }
      }
      if (!cancelled) setLoadingDrift(false);
    })();
    return () => { cancelled = true; };
  }, [site.id]);

  const onApplyTheme = async () => {
    setApplying(true);
    try {
      const resp = await fetch(`/api/sites/${site.id}/apply-theme`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fastTrack: false }),
      });
      const body = await resp.json();
      if (!resp.ok) {
        if (resp.status === 409 && body.error === 'theme_apply_conflict') {
          toast.error(`Theme update has ${body.details?.conflicts?.length ?? 0} conflicts — manual resolution required`);
        } else {
          toast.error(body.message ?? 'Apply failed');
        }
        return;
      }
      toast.success(`Theme update applied (${body.filesChanged} files changed)`);
      // Refetch drift status
      const driftResp = await fetch(`/api/sites/${site.id}/drift`);
      if (driftResp.ok) setDrift(await driftResp.json());
    } finally {
      setApplying(false);
    }
  };

  const onGraduateToExternal = async () => {
    const url = window.prompt('External Git repo URL (must be empty):');
    if (!url) return;
    const pat = window.prompt('One-time PAT with required scopes (will be dropped after key provisioning):');
    if (!pat) return;
    try {
      const resp = await fetch(`/api/sites/${site.id}/graduate-git`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ git_url: url, pat }),
      });
      const body = await resp.json();
      if (!resp.ok) {
        toast.error(body.message ?? 'Graduate failed');
        return;
      }
      toast.success('Graduated to external git');
      onSiteUpdated({ ...site, git_provenance: 'external', git_url: body.git_url } as SiteRow);
    } catch (err) {
      toast.error('Graduate failed (endpoint not yet implemented)');
    }
  };

  return (
    <div className="space-y-6">
      {/* Git source card */}
      <Card>
        <div className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-base font-semibold">Git source</h3>
                <Badge variant="soft" color={provenance === 'external' ? 'blue' : 'gray'} size="1">
                  {provenance}
                </Badge>
              </div>
              <p className="text-sm text-[var(--gray-a8)] font-mono break-all">{gitUrl}</p>
            </div>
            {provenance === 'internal' && (
              <Button variant="outlined" onClick={onGraduateToExternal}>
                <ArrowsRightLeftIcon className="size-4" /> Graduate to external git
              </Button>
            )}
          </div>

          {/* Drift status */}
          <div className="mt-4 pt-4 border-t border-[var(--gray-a3)]">
            {loadingDrift ? (
              <p className="text-sm text-[var(--gray-a8)]">Checking drift…</p>
            ) : drift ? (
              <div className="space-y-2">
                <div className="flex items-center gap-3 text-sm">
                  {drift.commitsAhead === 0 ? (
                    <>
                      <CheckCircleIcon className="size-5 text-green-500" />
                      <span>Up to date with main</span>
                    </>
                  ) : (
                    <>
                      <ExclamationCircleIcon className="size-5 text-yellow-500" />
                      <span>
                        <strong>{drift.commitsAhead}</strong> commit{drift.commitsAhead === 1 ? '' : 's'} ahead
                        {drift.blockSchemaChanges > 0 && ` (${drift.blockSchemaChanges} block schema change${drift.blockSchemaChanges === 1 ? '' : 's'})`}
                      </span>
                    </>
                  )}
                </div>
                {drift.mainHeadSha && (
                  <p className="text-xs text-[var(--gray-a8)] font-mono">
                    main {drift.mainHeadSha.slice(0, 8)} • publish {drift.publishHeadSha?.slice(0, 8) ?? '—'}
                  </p>
                )}
                {drift.commitsAhead > 0 && (
                  <Button onClick={onApplyTheme} disabled={applying} className="mt-2">
                    <ArrowUpTrayIcon className="size-4" />
                    {applying ? 'Applying…' : 'Apply theme update'}
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-sm text-[var(--gray-a8)]">Drift check unavailable</p>
            )}
          </div>
        </div>
      </Card>

      {/* Templates library binding (existing legacy view) */}
      <Card>
        <div className="p-5">
          <h3 className="text-base font-semibold mb-4">Templates library binding</h3>
          <SiteTemplateTab site={site} onSiteUpdated={onSiteUpdated} />
        </div>
      </Card>
    </div>
  );
}
