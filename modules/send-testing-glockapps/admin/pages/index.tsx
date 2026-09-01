import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowLeftIcon, ArrowPathIcon, TrashIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Badge, Button, Card, ConfirmModal } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { Spinner } from '@/components/ui/Spinner';
import PlacementService, { type GlockAppsStatus } from '../lib/placementService';

const inputCls =
  'w-full rounded-md border border-[var(--gray-7)] bg-[var(--color-surface)] px-3 py-2 text-sm disabled:opacity-60';

/**
 * Seed-address management for placement testing.
 *
 * Seeds are real third-party mailboxes, so they are managed separately from the
 * synthetic population: refreshing them must never disturb the test people, and
 * deleting the test people must never remove them.
 */
export default function GlockAppsSettingsPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<GlockAppsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pasted, setPasted] = useState('');
  const [showRemove, setShowRemove] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await PlacementService.getStatus());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleImport(useApi: boolean) {
    setBusy(true);
    try {
      const emails = useApi
        ? undefined
        : pasted
            .split(/[\s,;]+/)
            .map((value) => value.trim())
            .filter(Boolean);
      if (!useApi && (!emails || emails.length === 0)) {
        toast.error('Paste at least one seed address');
        return;
      }
      const res = await PlacementService.importSeeds(emails);
      toast.success(`Imported ${res.imported} seed addresses`);
      setPasted('');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    setBusy(true);
    try {
      const res = await PlacementService.removeSeeds();
      toast.success(`Removed ${res.deleted} seed addresses`);
      setShowRemove(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Removal failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <Page title="Placement testing">
        <div className="flex items-center justify-center py-24">
          <Spinner />
        </div>
      </Page>
    );
  }

  return (
    <Page title="Placement testing">
      <div className="p-6 space-y-6 max-w-3xl">
        <div>
          <button
            type="button"
            className="text-sm text-[var(--gray-11)] hover:text-[var(--gray-12)] flex items-center gap-1"
            onClick={() => navigate('/send-testing')}
          >
            <ArrowLeftIcon className="h-4 w-4" />
            Send Testing
          </button>
          <h1 className="text-xl font-semibold text-[var(--gray-12)] mt-1 flex items-center gap-2">
            Placement testing
            <Badge color={status?.mode === 'api' ? 'green' : 'gray'}>{status?.mode} mode</Badge>
          </h1>
          <p className="text-sm text-[var(--gray-11)] mt-1">
            GlockApps seed mailboxes answer whether a message reaches the inbox. Without an API key
            everything still works by entering dashboard results by hand.
          </p>
        </div>

        <Card className="p-4">
          <div className="text-sm font-medium text-[var(--gray-12)]">Seed addresses</div>
          <p className="text-xs text-[var(--gray-11)] mt-1">
            Currently <strong>{status?.seed_count ?? 0}</strong> subscribed on the{' '}
            {status?.seed_list_mode === 'separate'
              ? 'separate placement list'
              : 'shared Bulk Send Testing list'}
            . Seed lists rotate, so refresh them before each run rather than trusting an old import.
          </p>

          <div className="mt-3 space-y-3">
            {status?.mode === 'api' && (
              <Button size="sm" variant="outline" onClick={() => handleImport(true)} disabled={busy}>
                <ArrowPathIcon className="h-4 w-4 mr-1" />
                Fetch current seed list from GlockApps
              </Button>
            )}

            <label className="block text-sm">
              <span className="text-[var(--gray-11)]">
                Or paste addresses from the dashboard (one per line)
              </span>
              <textarea
                className={inputCls}
                rows={6}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder={'seed1@example.com\nseed2@example.net'}
              />
            </label>

            <div className="flex gap-2">
              <Button size="sm" onClick={() => handleImport(false)} disabled={busy || !pasted.trim()}>
                Import pasted addresses
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowRemove(true)}
                disabled={busy || !status?.seed_count}
              >
                <TrashIcon className="h-4 w-4 mr-1" />
                Remove all seeds
              </Button>
            </div>
          </div>
        </Card>

        <Card className="p-4 text-xs text-[var(--gray-11)] space-y-2">
          <p className="text-sm font-medium text-[var(--gray-12)]">Notes</p>
          <p>
            Seed addresses get no timezone attribute, so a timezone-aware send dispatches to them
            immediately rather than holding them for a local-time window.
          </p>
          <p>
            They are marked as test data and stay out of the People dashboard, alongside the
            synthetic population. Removing them here never touches the synthetic test people, and
            deleting the test people never touches these.
          </p>
          <p>
            Keep the campaign's real subject line for placement runs. Artificial subject markers can
            change how a provider classifies the message, which is the very thing being measured.
          </p>
        </Card>
      </div>

      <ConfirmModal
        isOpen={showRemove}
        onClose={() => setShowRemove(false)}
        onConfirm={handleRemove}
        title="Remove seed addresses"
        confirmText="Remove"
        confirmColor="red"
        message="Deletes the GlockApps seed people and their subscriptions. The synthetic test population is unaffected."
      />
    </Page>
  );
}
