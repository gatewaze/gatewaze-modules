/**
 * Admin: Webhooks (Layer-2 outbound webhook subscriptions).
 *
 * Lists every subscription scoped to the active site. Operators can:
 *
 *   - Add a subscription (URL + topics → cleartext secret shown once).
 *   - Edit (URL, topics, status). Re-enabling a suspended row clears
 *     consecutive_failures so the next failure starts fresh.
 *   - Rotate the secret (returns new cleartext; previous remains valid
 *     until next rotate or update).
 *   - Send a synthetic test event (does NOT write to webhook_deliveries).
 *   - Delete.
 *
 * Delivery health surfaces on each row via the last_success_at /
 * last_failure_at / consecutive_failures columns we already select.
 * A full deliveries audit-log view is a follow-up; for now the per-row
 * "last failure message" link in the table opens a tooltip with the
 * latest error.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  PencilIcon,
  TrashIcon,
  PlusIcon,
  ArrowPathIcon,
  PaperAirplaneIcon,
  ClipboardDocumentIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';

import { Button, Modal, Badge } from '@/components/ui';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

import {
  listWebhookSubscriptions,
  listWebhookEventTopics,
  getDefaultSiteId,
  createWebhookSubscription,
  updateWebhookSubscription,
  deleteWebhookSubscription,
  rotateWebhookSecret,
  sendWebhookTest,
  type WebhookSubscription,
  type WebhookSubscriptionStatus,
  type WebhookEventTopic,
} from '../utils/webhooksService';

interface Draft {
  id?: string;
  url: string;
  topics: string[];
  status: WebhookSubscriptionStatus;
}

const EMPTY_DRAFT: Draft = {
  url: '',
  topics: [],
  status: 'enabled',
};

export default function WebhooksTab() {
  const [subscriptions, setSubscriptions] = useState<WebhookSubscription[]>([]);
  const [topics, setTopics] = useState<WebhookEventTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [modalDraft, setModalDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingSub, setDeletingSub] = useState<WebhookSubscription | null>(null);
  const [secretToReveal, setSecretToReveal] = useState<{
    url: string;
    secret: string;
    rotated?: boolean;
  } | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const [site, topicRows] = await Promise.all([
        getDefaultSiteId(),
        listWebhookEventTopics(),
      ]);
      setSiteId(site);
      setTopics(topicRows);
      if (site) {
        const subs = await listWebhookSubscriptions(site);
        setSubscriptions(subs);
      } else {
        setSubscriptions([]);
      }
    } catch (err) {
      console.error('[webhooks] load failed', err);
      toast.error('Failed to load webhook subscriptions');
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setModalDraft({ ...EMPTY_DRAFT });
  }

  function openEdit(sub: WebhookSubscription) {
    setModalDraft({
      id: sub.id,
      url: sub.url,
      topics: [...sub.topics],
      status: sub.status,
    });
  }

  async function handleSave() {
    if (!modalDraft) return;
    if (!modalDraft.url.trim()) {
      toast.error('URL is required');
      return;
    }
    if (!siteId) {
      toast.error('No site configured');
      return;
    }

    setSaving(true);
    try {
      if (modalDraft.id) {
        await updateWebhookSubscription(siteId, modalDraft.id, {
          url: modalDraft.url.trim(),
          topics: modalDraft.topics,
          status: modalDraft.status,
        });
        toast.success('Subscription updated');
        setModalDraft(null);
        await load();
      } else {
        const result = await createWebhookSubscription(siteId, {
          url: modalDraft.url.trim(),
          topics: modalDraft.topics,
          status: modalDraft.status,
        });
        toast.success('Subscription created');
        setModalDraft(null);
        // Show the cleartext secret immediately — this is the only
        // chance to capture it. We don't close the reveal modal until
        // the operator dismisses it.
        setSecretToReveal({ url: result.subscription.url, secret: result.secret });
        await load();
      }
    } catch (err) {
      console.error('[webhooks] save failed', err);
      const msg = err instanceof Error ? err.message : 'Save failed';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deletingSub || !siteId) return;
    try {
      await deleteWebhookSubscription(siteId, deletingSub.id);
      toast.success('Subscription deleted');
      setDeletingSub(null);
      await load();
    } catch (err) {
      console.error('[webhooks] delete failed', err);
      toast.error('Delete failed');
    }
  }

  async function handleRotate(sub: WebhookSubscription) {
    if (!siteId) return;
    try {
      const result = await rotateWebhookSecret(siteId, sub.id);
      setSecretToReveal({ url: sub.url, secret: result.secret, rotated: true });
      await load();
    } catch (err) {
      console.error('[webhooks] rotate failed', err);
      const msg = err instanceof Error ? err.message : 'Rotate failed';
      toast.error(msg);
    }
  }

  async function handleTest(sub: WebhookSubscription) {
    if (!siteId) return;
    setTestingId(sub.id);
    try {
      const result = await sendWebhookTest(siteId, sub.id);
      if (result.error) {
        toast.error(`Test failed: ${result.error}`);
      } else if (result.status >= 200 && result.status < 300) {
        toast.success(`Test ok — ${result.status} in ${result.duration_ms}ms`);
      } else {
        toast.error(
          `Subscriber returned ${result.status} (${result.duration_ms}ms): ${result.response_body_preview.slice(0, 120)}`,
        );
      }
    } catch (err) {
      console.error('[webhooks] test failed', err);
      const msg = err instanceof Error ? err.message : 'Test failed';
      toast.error(msg);
    } finally {
      setTestingId(null);
    }
  }

  function toggleTopicInDraft(topic: string) {
    if (!modalDraft) return;
    const next = modalDraft.topics.includes(topic)
      ? modalDraft.topics.filter((t) => t !== topic)
      : [...modalDraft.topics, topic];
    setModalDraft({ ...modalDraft, topics: next });
  }

  const topicLookup = useMemo(() => {
    const m = new Map<string, WebhookEventTopic>();
    for (const t of topics) m.set(t.topic, t);
    return m;
  }, [topics]);

  if (loading) {
    return (
      <div className="p-8 flex justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Webhooks</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Outbound subscriptions that fire on content mutations. Subscribers
            receive a signed POST per spec-api-cache-and-revalidation Layer 2;
            the theme&apos;s <code>/api/revalidate</code> handler is the
            canonical consumer.
          </p>
        </div>
        <Button onClick={openCreate} disabled={!siteId}>
          <PlusIcon className="size-4 mr-2" />
          New subscription
        </Button>
      </header>

      {!siteId && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          No site found. Create a site before adding webhook subscriptions.
        </div>
      )}

      {siteId && subscriptions.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-neutral-500">
          No webhook subscriptions yet. Click <strong>New subscription</strong> to
          point a theme at this Gatewaze instance.
        </div>
      ) : siteId && (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50">
              <tr className="text-left">
                <th className="px-4 py-2">Subscriber URL</th>
                <th className="px-4 py-2">Topics</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Last delivery</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((sub) => (
                <tr key={sub.id} className="border-t hover:bg-neutral-50 align-top">
                  <td className="px-4 py-3 font-mono text-xs break-all max-w-md">
                    {sub.url}
                  </td>
                  <td className="px-4 py-3">
                    {sub.topics.length === 0 ? (
                      <span className="text-neutral-400 text-xs">all topics</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {sub.topics.map((t) => (
                          <Badge key={t} title={topicLookup.get(t)?.description ?? t}>
                            {t}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge>{sub.status}</Badge>
                    {sub.status === 'suspended' && (
                      <div className="text-xs text-amber-700 mt-1">
                        {sub.consecutive_failures} consecutive failures
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-neutral-500">
                    <DeliveryStatus sub={sub} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleTest(sub)}
                        disabled={testingId === sub.id}
                        title="Send test event"
                      >
                        <PaperAirplaneIcon className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRotate(sub)}
                        title="Rotate secret"
                      >
                        <ArrowPathIcon className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(sub)}
                        title="Edit"
                      >
                        <PencilIcon className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeletingSub(sub)}
                        title="Delete"
                      >
                        <TrashIcon className="size-4 text-red-600" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalDraft && (
        <Modal
          isOpen
          onClose={() => setModalDraft(null)}
          title={modalDraft.id ? 'Edit subscription' : 'New subscription'}
          size="lg"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setModalDraft(null)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : modalDraft.id ? 'Save' : 'Create'}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <Field
              label="Subscriber URL"
              hint="HTTPS endpoint that accepts signed POSTs. For local dev, http://host.docker.internal:<port>/api/revalidate works."
            >
              <input
                className="form-input w-full"
                value={modalDraft.url}
                onChange={(e) => setModalDraft({ ...modalDraft, url: e.target.value })}
                placeholder="https://example.com/api/revalidate"
              />
            </Field>
            <Field
              label="Topics"
              hint="Leave empty to subscribe to ALL registered topics. Tick to scope."
            >
              <div className="border rounded-md divide-y max-h-64 overflow-auto">
                {topics.length === 0 && (
                  <div className="text-xs text-neutral-500 px-3 py-2">
                    No topics registered. Content modules register topics in
                    their own migrations.
                  </div>
                )}
                {topics.map((t) => (
                  <label
                    key={t.topic}
                    className="flex items-start gap-3 px-3 py-2 hover:bg-neutral-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={modalDraft.topics.includes(t.topic)}
                      onChange={() => toggleTopicInDraft(t.topic)}
                    />
                    <div className="flex-1">
                      <div className="font-medium text-sm">{t.topic}</div>
                      {t.description && (
                        <div className="text-xs text-neutral-500 mt-0.5">
                          {t.description}
                        </div>
                      )}
                      <div className="text-xs text-neutral-400 mt-0.5 font-mono">
                        surrogate key: {t.surrogate_key_template}
                        {t.detail_key_template && ` · ${t.detail_key_template}`}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Status">
              <select
                className="form-input w-full"
                value={modalDraft.status}
                onChange={(e) =>
                  setModalDraft({
                    ...modalDraft,
                    status: e.target.value as WebhookSubscriptionStatus,
                  })
                }
              >
                <option value="enabled">enabled</option>
                <option value="disabled">disabled</option>
              </select>
            </Field>
          </div>
        </Modal>
      )}

      {secretToReveal && (
        <Modal
          isOpen
          onClose={() => setSecretToReveal(null)}
          title={secretToReveal.rotated ? 'Secret rotated' : 'Subscription secret'}
          size="md"
          footer={
            <div className="flex justify-end">
              <Button onClick={() => setSecretToReveal(null)}>I&apos;ve saved it</Button>
            </div>
          }
        >
          <div className="space-y-4 text-sm">
            <p>
              Copy this secret into the subscriber&apos;s{' '}
              <code>GATEWAZE_WEBHOOK_SECRETS</code> environment variable. It
              will <strong>not</strong> be shown again.
            </p>
            <div className="rounded-md bg-neutral-900 text-neutral-100 p-3 font-mono text-xs break-all flex items-center justify-between gap-2">
              <span>{secretToReveal.secret}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(secretToReveal.secret);
                  toast.success('Copied');
                }}
                title="Copy"
              >
                <ClipboardDocumentIcon className="size-4 text-neutral-100" />
              </Button>
            </div>
            <p className="text-xs text-neutral-500">
              For URL <code>{secretToReveal.url}</code>.
              {secretToReveal.rotated && (
                <>
                  {' '}The previous secret remains valid until the next rotate
                  or update — set the new value in the subscriber first, then
                  trigger a redeploy.
                </>
              )}
            </p>
          </div>
        </Modal>
      )}

      <ConfirmModal
        isOpen={Boolean(deletingSub)}
        onClose={() => setDeletingSub(null)}
        onConfirm={handleDelete}
        title="Delete subscription"
        message={
          deletingSub
            ? `Permanently delete the subscription for ${deletingSub.url}? The subscriber will stop receiving events immediately.`
            : ''
        }
        confirmText="Delete"
        confirmColor="red"
      />
    </div>
  );
}

function DeliveryStatus({ sub }: { sub: WebhookSubscription }) {
  if (sub.last_success_at && sub.last_failure_at) {
    const succeededLast = sub.last_success_at > sub.last_failure_at;
    return (
      <div>
        <div className={succeededLast ? 'text-green-700' : 'text-red-700'}>
          {succeededLast ? '✓ ' : '✗ '}
          {new Date(succeededLast ? sub.last_success_at : sub.last_failure_at).toLocaleString()}
        </div>
        {!succeededLast && sub.last_failure_message && (
          <div className="mt-1 text-red-600 font-mono text-[10px] line-clamp-2" title={sub.last_failure_message}>
            {sub.last_failure_message}
          </div>
        )}
      </div>
    );
  }
  if (sub.last_success_at) {
    return (
      <div className="text-green-700">
        ✓ {new Date(sub.last_success_at).toLocaleString()}
      </div>
    );
  }
  if (sub.last_failure_at) {
    return (
      <div className="text-red-700">
        ✗ {new Date(sub.last_failure_at).toLocaleString()}
        {sub.last_failure_message && (
          <div className="mt-1 text-red-600 font-mono text-[10px] line-clamp-2" title={sub.last_failure_message}>
            {sub.last_failure_message}
          </div>
        )}
      </div>
    );
  }
  return <span className="text-neutral-400">never</span>;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-neutral-700 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-neutral-500 mt-1">{hint}</span>}
    </label>
  );
}
