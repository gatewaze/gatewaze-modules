/**
 * Publishing tab — pick how this site publishes (portal / external) and
 * configure publisher secrets when external. The k8s-internal kind was
 * dropped from the UI in favour of external publishers; the type union
 * still admits it for legacy rows that may exist on long-running installs.
 *
 * External publisher selection is registry-based: the admin app dynamically
 * imports each publisher module's `secretsSchema` and `PUBLISHER_LABEL`. To
 * add a publisher, create a new `sites-publisher-*` module that exports both,
 * then add it to PUBLISHER_REGISTRY below. The schema-driven editor renders
 * the form; sites_secrets writes go through a server endpoint that
 * encrypts the values.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowUturnLeftIcon } from '@heroicons/react/24/outline';
import { Badge, Button, Card, Select } from '@/components/ui';
import { SchemaEditor } from '../schema-editor';
import { SitesService, PublishJobsService, type PublishJobSummary } from '../services/sitesService';
import type { SiteRow, PublishingTarget } from '../../types';
import { supabase } from '@/lib/supabase';

// ----------------------------------------------------------------------------
// Publisher registry
// ----------------------------------------------------------------------------

interface PublisherEntry {
  id: string;
  label: string;
  secretsSchema: Record<string, unknown>;
}

// Lazy-load each publisher module so installs without that publisher don't
// blow up the import. The publisher modules are pure config (schema + label),
// so the dynamic import is cheap and safe.
async function loadPublisherRegistry(): Promise<PublisherEntry[]> {
  const entries: PublisherEntry[] = [];
  const candidates = [
    { id: 'sites-publisher-cloudflare-pages', mod: () => import(/* @vite-ignore */ '@premium-gatewaze-modules/sites-publisher-cloudflare-pages') },
    { id: 'sites-publisher-netlify',          mod: () => import(/* @vite-ignore */ '@premium-gatewaze-modules/sites-publisher-netlify') },
  ];
  for (const c of candidates) {
    try {
      const mod = await c.mod();
      const m = mod as unknown as { secretsSchema?: Record<string, unknown>; PUBLISHER_LABEL?: string };
      if (m.secretsSchema && m.PUBLISHER_LABEL) {
        entries.push({ id: c.id, label: m.PUBLISHER_LABEL, secretsSchema: m.secretsSchema });
      }
    } catch {
      // Module not installed in this brand — skip silently.
    }
  }
  return entries;
}

// ----------------------------------------------------------------------------
// Component
// ----------------------------------------------------------------------------

export function SitePublishingTab({
  site,
  onSiteUpdated,
}: {
  site: SiteRow;
  onSiteUpdated: (s: SiteRow) => void;
}) {
  const [registry, setRegistry] = useState<PublisherEntry[]>([]);
  const [loadingRegistry, setLoadingRegistry] = useState(true);

  const [kind, setKind] = useState<PublishingTarget['kind']>(site.publishing_target.kind);
  const [publisherId, setPublisherId] = useState<string>(site.publishing_target.publisherId ?? '');

  const [secretsValue, setSecretsValue] = useState<Record<string, unknown>>({});
  const [savingTarget, setSavingTarget] = useState(false);
  const [savingSecrets, setSavingSecrets] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    errors: ReadonlyArray<{ path: string; message: string }>;
    ping: { ok: boolean; status: number | null; message: string } | null;
  } | null>(null);

  useEffect(() => {
    loadPublisherRegistry().then((r) => {
      setRegistry(r);
      setLoadingRegistry(false);
    });
  }, []);

  const activePublisher = registry.find((p) => p.id === publisherId);
  const configRefForPublisher = (pid: string) => `publisher_${pid.replace(/-/g, '_')}`;

  const saveTarget = async () => {
    setSavingTarget(true);
    const newTarget: PublishingTarget =
      kind === 'external'
        ? { kind, publisherId, configRef: publisherId ? configRefForPublisher(publisherId) : undefined }
        : { kind: 'portal' };
    const { site: updated, error } = await SitesService.updateSite(site.id, {
      publishing_target: newTarget,
    });
    setSavingTarget(false);
    if (error || !updated) {
      toast.error(`Save failed: ${error}`);
      return;
    }
    toast.success('Publishing target saved');
    onSiteUpdated(updated);
  };

  const testConnection = async (values?: Record<string, unknown>) => {
    if (!publisherId) {
      toast.error('Pick a publisher first');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const apiUrl = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const body: Record<string, unknown> = { publisherId };
      if (values && Object.keys(values).length > 0) body.values = values;
      const res = await fetch(`${apiUrl}/api/modules/sites/admin/sites/${site.id}/publisher:validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(result?.error?.message ?? `Failed (${res.status})`);
        setTestResult(null);
        return;
      }
      setTestResult(result as Parameters<typeof setTestResult>[0]);
      if (result.ok) toast.success('Connection OK');
      else toast.error('Connection failed — see details below');
    } finally {
      setTesting(false);
    }
  };

  const saveSecrets = async ({
    content,
  }: {
    route: string;
    content: Record<string, unknown>;
    schemaVersion: number;
    baseCommitSha: string | null;
  }) => {
    if (!publisherId) {
      throw new Error('Pick a publisher first');
    }
    setSavingSecrets(true);
    try {
      const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const res = await fetch(`${apiUrl}/api/modules/sites/admin/sites/${site.id}/secrets`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          key: configRefForPublisher(publisherId),
          values: content,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `Failed (${res.status})`);
      }
      toast.success('Secrets saved (encrypted server-side)');
      setSecretsValue(content);
    } finally {
      setSavingSecrets(false);
    }
  };

  // Portal site publishes via the platform's own deploy pipeline — its
  // publishing target is fixed and not editable here.
  if (site.publishing_target.kind === 'portal' && site.slug === 'portal') {
    return <PortalPublishingView />;
  }

  return (
    <div className="space-y-4">
      <RolloutsCard siteId={site.id} />

      <Card>
        <div className="p-4 space-y-4">
          <h3 className="text-sm font-semibold">Publishing target</h3>
          <Select
            label="Where do pages get published to?"
            value={kind}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setKind(e.target.value as PublishingTarget['kind'])}
            data={[
              { value: 'external', label: 'External — Cloudflare Pages / Netlify' },
              { value: 'portal', label: 'Portal — served inline by this gatewaze instance' },
            ]}
          />

          {kind === 'external' && (
            <div>
              <Select
                label="Publisher"
                value={publisherId}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPublisherId(e.target.value)}
                disabled={loadingRegistry}
                data={[
                  { value: '', label: loadingRegistry ? 'Loading...' : '— pick a publisher —' },
                  ...registry.map((p) => ({ value: p.id, label: p.label })),
                ]}
              />
              {!loadingRegistry && registry.length === 0 && (
                <p className="mt-2 text-sm text-[var(--gray-a8)]">
                  No external publisher modules are installed. Install{' '}
                  <span className="font-mono">sites-publisher-cloudflare-pages</span> or{' '}
                  <span className="font-mono">sites-publisher-netlify</span> from the Modules dashboard.
                </p>
              )}
              {site.theme_kind === 'website' && kind !== 'external' && kind !== 'portal' && (
                <p className="mt-2 text-sm text-[var(--warning-11)]">
                  Sites publish to either an external publisher or the built-in portal. Switching
                  to k8s-internal will be rejected by the DB trigger.
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end">
            <Button onClick={saveTarget} disabled={savingTarget || (kind === 'external' && !publisherId)}>
              {savingTarget ? 'Saving...' : 'Save target'}
            </Button>
          </div>
        </div>
      </Card>

      {kind === 'external' && publisherId && activePublisher && (
        <Card>
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{activePublisher.label} secrets</h3>
              <Button
                type="button"
                variant="outlined"
                size="sm"
                disabled={testing}
                onClick={() => testConnection(secretsValue)}
              >
                {testing ? 'Testing...' : 'Test connection'}
              </Button>
            </div>
            <p className="text-xs text-[var(--gray-a8)]">
              Encrypted server-side and stored in <span className="font-mono">sites_secrets</span>{' '}
              under key <span className="font-mono">{configRefForPublisher(publisherId)}</span>. Save
              writes the new bundle (overwrite); existing tokens are not echoed back to the form.
              "Test connection" validates the form values (or stored secrets when the form is empty)
              and pings the publisher's API to confirm credentials authenticate.
            </p>

            {testResult && (
              <div
                className={`rounded-lg border p-3 text-sm space-y-1 ${
                  testResult.ok
                    ? 'border-[var(--success-7)] bg-[var(--success-a3)] text-[var(--success-12)]'
                    : 'border-[var(--error-7)] bg-[var(--error-a3)] text-[var(--error-12)]'
                }`}
              >
                <div className="font-medium">
                  {testResult.ok ? 'Connection OK ✓' : 'Connection failed ✗'}
                </div>
                {testResult.errors.length > 0 && (
                  <ul className="list-disc ml-5">
                    {testResult.errors.map((e, i) => (
                      <li key={i}>
                        <span className="font-mono">{e.path || '(root)'}</span>: {e.message}
                      </li>
                    ))}
                  </ul>
                )}
                {testResult.ping && (
                  <div className="text-xs">
                    Live ping:{' '}
                    {testResult.ping.status !== null && (
                      <span className="font-mono">{testResult.ping.status}</span>
                    )}{' '}
                    — {testResult.ping.message}
                  </div>
                )}
              </div>
            )}

            <SchemaEditor
              route={`/${publisherId}`}
              schema={activePublisher.secretsSchema}
              schemaVersion={1}
              initialContent={secretsValue}
              baseCommitSha={null}
              onSave={saveSecrets}
            />
            {savingSecrets && <p className="text-sm text-[var(--gray-a8)]">Saving secrets...</p>}
          </div>
        </Card>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Rollouts (publish-job history) + rollback affordance
// ----------------------------------------------------------------------------

const STATUS_COLOR: Record<string, 'success' | 'error' | 'warning' | 'neutral' | 'info'> = {
  succeeded: 'success',
  failed: 'error',
  build_failed: 'error',
  finalization_failed: 'error',
  cancelled: 'neutral',
  conflict: 'warning',
  queued: 'info',
  preparing: 'info',
  committing: 'info',
  awaiting_build: 'info',
  build_started: 'info',
  finalizing: 'info',
};

function RolloutsCard({ siteId }: { siteId: string }) {
  const [jobs, setJobs] = useState<PublishJobSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    setLoading(true);
    const { jobs, error } = await PublishJobsService.listForSite(siteId, 25);
    if (error) toast.error(`Rollouts: ${error}`);
    setJobs(jobs);
    setLoading(false);
  };

  useEffect(() => { reload(); }, [siteId]);

  return (
    <Card>
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-[var(--gray-12)]">Rollouts</h3>
          <Button size="sm" variant="outlined" onClick={reload} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>
        {jobs.length === 0 ? (
          <p className="text-sm text-[var(--gray-a8)]">
            No publish jobs yet. The history of every publish + rollback shows up here once your
            first page goes live.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {jobs.map((j) => (
              <li
                key={j.id}
                className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-[var(--gray-a2)]"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Badge color={STATUS_COLOR[j.status] ?? 'neutral'}>{j.status}</Badge>
                  <span className="text-xs font-mono text-[var(--gray-a9)] truncate">
                    {j.publisher_id.replace(/^sites-publisher-/, '')}
                  </span>
                  {j.result_deployment_url && (
                    <a
                      href={j.result_deployment_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-[var(--accent-11)] underline truncate"
                    >
                      {new URL(j.result_deployment_url).hostname}
                    </a>
                  )}
                  {j.error && (
                    <span className="text-xs text-[var(--error-11)] truncate" title={j.error}>
                      {j.error}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs text-[var(--gray-a8)] shrink-0">
                  <span>{new Date(j.finished_at ?? j.created_at).toLocaleString()}</span>
                  {j.status === 'succeeded' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        toast.message(
                          'Rollback affordance: pending API endpoint (POST /admin/sites/:id/publish-jobs/:job/rollback). The DB row already preserves the prior content snapshot.',
                        )
                      }
                      aria-label="Roll back to this version"
                    >
                      <ArrowUturnLeftIcon className="size-4" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

// Read-only view for the seeded "Portal" site.
function PortalPublishingView() {
  const buildSha =
    (import.meta as { env: Record<string, string | undefined> }).env.VITE_PORTAL_BUILD_SHA ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <div className="p-4 space-y-2 text-sm">
          <h3 className="text-sm font-semibold text-[var(--gray-12)]">Built-in portal</h3>
          <p className="text-[var(--gray-a8)]">
            The Portal site is the platform's admin and member-facing UI. It deploys via the
            platform's own pipeline (CI builds the portal Next.js app and the operator's container
            orchestrator rolls it out); there are no per-site publishing controls or rollbacks here.
          </p>
          <div className="mt-2 flex items-center gap-3">
            <span className="text-[var(--gray-a8)]">Deployed build:</span>
            <span className="font-mono text-[var(--gray-12)]">{buildSha ?? 'unknown (set VITE_PORTAL_BUILD_SHA at build time)'}</span>
          </div>
        </div>
      </Card>
    </div>
  );
}
