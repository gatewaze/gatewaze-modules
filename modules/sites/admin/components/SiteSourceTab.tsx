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
import { Badge, Button, Card, Input, Modal } from '@/components/ui';
import {
  ArrowsRightLeftIcon,
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
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

interface ImportGitForm {
  git_url: string;
  pat: string;
  branch: string;
  schema_path: string;
}

export function SiteSourceTab({ site, onSiteUpdated }: SiteSourceTabProps) {
  const [drift, setDrift] = useState<DriftStatus | null>(null);
  const [loadingDrift, setLoadingDrift] = useState(true);
  const [applying, setApplying] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [validating, setValidating] = useState(false);

  const importForm = useForm<ImportGitForm>({
    defaultValues: { git_url: '', pat: '', branch: 'main', schema_path: 'content/schema.json' },
  });

  const provenance = site.git_provenance ?? 'internal';
  const gitUrl = site.git_url ?? `(internal: ${site.slug}.git)`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingDrift(true);
      // GET /api/admin/sites/:id/drift — mounted under /api/admin/* by
      // register-routes.ts's mountSourceRoutes(adminRouter, ...).
      try {
        const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
        const { data: session } = await supabase.auth.getSession();
        const token = session.session?.access_token;
        const resp = await fetch(`${apiUrl}/api/admin/sites/${site.id}/drift`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
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
      const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const resp = await fetch(`${apiUrl}/api/admin/sites/${site.id}/apply-theme`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
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
      const driftResp = await fetch(`${apiUrl}/api/admin/sites/${site.id}/drift`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (driftResp.ok) setDrift(await driftResp.json());
    } finally {
      setApplying(false);
    }
  };

  const onValidateCanvasTemplates = async () => {
    setValidating(true);
    try {
      const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const resp = await fetch(`${apiUrl}/api/admin/sites/${site.slug}/canvas-validate-templates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        toast.error(body?.error?.message ?? `Validation failed (${resp.status})`);
        return;
      }
      const summary = body as { totalBlockDefs: number; valid: number; invalid: number };
      if (summary.invalid === 0) {
        toast.success(`All ${summary.valid} block templates valid for the canvas.`);
      } else {
        toast.error(`${summary.invalid} of ${summary.totalBlockDefs} templates failed canvas validation — fix in the theme repo and re-run.`);
      }
    } finally {
      setValidating(false);
    }
  };

  const onImportGit = async (data: ImportGitForm) => {
    setImporting(true);
    try {
      const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const resp = await fetch(`${apiUrl}/api/modules/sites/admin/sites/${site.id}/source:import-git`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(data),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        toast.error(body?.error?.message ?? `Import failed (${resp.status})`);
        return;
      }
      toast.success(`Imported schema v${body.schemaVersion} from ${data.branch}`);
      setShowImport(false);
      importForm.reset();
      onSiteUpdated({ ...site, templates_library_id: body.libraryId } as SiteRow);
    } catch (err) {
      toast.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  const onGraduateToExternal = async () => {
    const url = window.prompt('External Git repo URL (must be empty):');
    if (!url) return;
    const pat = window.prompt('One-time PAT with required scopes (will be dropped after key provisioning):');
    if (!pat) return;
    try {
      const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const resp = await fetch(`${apiUrl}/api/admin/sites/${site.id}/graduate-git`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
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
            <div className="flex items-center gap-2">
              <Button variant="outlined" onClick={() => setShowImport(true)}>
                <ArrowDownTrayIcon className="size-4" /> Import from git repo
              </Button>
              {provenance === 'internal' && (
                <Button variant="outlined" onClick={onGraduateToExternal}>
                  <ArrowsRightLeftIcon className="size-4" /> Move to my own git repo
                </Button>
              )}
            </div>
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

      {/* Canvas template validation */}
      <Card>
        <div className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold">Canvas templates</h3>
              <p className="text-sm text-[var(--gray-a8)] mt-1">
                Re-runs the WYSIWYG canvas validator against every block template in the bound library.
                Updates <code className="font-mono text-xs">canvas_validated</code> per template — only validated
                templates are offered in the canvas block palette.
              </p>
            </div>
            <Button onClick={onValidateCanvasTemplates} disabled={validating} variant="outlined">
              <CheckCircleIcon className="size-4" />
              {validating ? 'Validating…' : 'Re-validate canvas templates'}
            </Button>
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

      {/* Connect external git template modal */}
      <Modal
        isOpen={showImport}
        onClose={() => { setShowImport(false); importForm.reset(); }}
        title="Connect external git template"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outlined"
              onClick={() => { setShowImport(false); importForm.reset(); }}
              disabled={importing}
            >
              Cancel
            </Button>
            <Button onClick={importForm.handleSubmit(onImportGit)} disabled={importing}>
              {importing ? 'Cloning…' : 'Import'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--gray-a8)]">
            Clone an external Next.js theme repo and ingest its <span className="font-mono">content/schema.json</span>{' '}
            into this site's library. The PAT is consumed once for the clone, then stored encrypted under{' '}
            <span className="font-mono">git_pat_&lt;source_id&gt;</span> for future pulls.
          </p>
          <Input
            label="HTTPS git URL"
            placeholder="https://github.com/your-org/your-theme.git"
            {...importForm.register('git_url', {
              required: 'Required',
              pattern: { value: /^https:\/\/.+/, message: 'Must be https://' },
            })}
            error={importForm.formState.errors.git_url?.message}
          />
          <Input
            label="Personal access token"
            type="password"
            placeholder="github_pat_..."
            {...importForm.register('pat', { required: 'Required' })}
            error={importForm.formState.errors.pat?.message}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Branch"
              placeholder="main"
              {...importForm.register('branch', { required: 'Required' })}
              error={importForm.formState.errors.branch?.message}
            />
            <Input
              label="Schema path"
              placeholder="content/schema.json"
              {...importForm.register('schema_path', { required: 'Required' })}
              error={importForm.formState.errors.schema_path?.message}
            />
          </div>
          <p className="text-xs text-[var(--gray-a8)]">
            v1: only JSON-format schemas are read. <span className="font-mono">schema.ts</span> compilation
            lands in a follow-up.
          </p>
        </div>
      </Modal>
    </div>
  );
}
