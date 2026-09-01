import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { EnvelopeIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Badge, Button, Card, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { Spinner } from '@/components/ui/Spinner';
import SendTestingService, { type Arrival, type TestPerson } from '../lib/sendTestingService';
import { SEND_TESTING_TABS } from './index';

/**
 * Test inboxes.
 *
 * Only the inspectable sample keeps message bodies, so only they can be opened.
 * The point of opening one is to exercise the real links — above all the
 * unsubscribe link, which runs the genuine flow against that test person and
 * actually flips their subscription.
 *
 * The message renders in a sandboxed iframe. It is attacker-shaped content by
 * construction (whatever the send pipeline produced), and the sandbox keeps
 * scripts and tracking pixels away from the admin origin while leaving links
 * clickable, which is the entire feature.
 */
export default function SendTestInboxPage() {
  const { email: emailParam } = useParams<{ email: string }>();
  const navigate = useNavigate();

  const [people, setPeople] = useState<TestPerson[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  const [message, setMessage] = useState<Arrival | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingArrivals, setLoadingArrivals] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await SendTestingService.listPeople();
        setPeople(res.data);
        const initial =
          emailParam && emailParam !== 'inspectable'
            ? decodeURIComponent(emailParam)
            : (res.data[0]?.email ?? null);
        setSelected(initial);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to load test people');
      } finally {
        setLoading(false);
      }
    })();
  }, [emailParam]);

  const loadArrivals = useCallback(async (email: string) => {
    setLoadingArrivals(true);
    setMessage(null);
    try {
      const res = await SendTestingService.listArrivals(email);
      setArrivals(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load inbox');
      setArrivals([]);
    } finally {
      setLoadingArrivals(false);
    }
  }, []);

  useEffect(() => {
    if (selected) loadArrivals(selected);
  }, [selected, loadArrivals]);

  async function openMessage(arrival: Arrival) {
    if (!arrival.has_body) {
      toast.info('Only the inspectable sample keeps message bodies');
      return;
    }
    try {
      setMessage(await SendTestingService.getArrival(arrival.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to open message');
    }
  }

  const selectedPerson = people.find((p) => p.email === selected) ?? null;
  const unsubscribeHeader = message?.headers_meta?.list_unsubscribe as string | undefined;

  if (loading) {
    return (
      <Page title="Test inboxes">
        <div className="flex items-center justify-center py-24">
          <Spinner />
        </div>
      </Page>
    );
  }

  return (
    <Page title="Test inboxes">
      <WorkspaceLayout
        title="Send Testing"
        tabs={SEND_TESTING_TABS}
        activeTabId="people"
        onTabChange={(t) => navigate(t === 'runs' ? '/send-testing' : `/send-testing/${t}`)}
        breadcrumbs={[{ label: 'Test people', to: '/send-testing/people' }, { label: 'Inboxes' }]}
        onBreadcrumbNavigate={(to) => navigate(to)}
      >
      <div className="p-6 space-y-4">
        <p className="text-sm text-[var(--gray-11)] max-w-3xl">
          These recipients keep the delivered HTML so a message can be opened and its real links
          clicked. Clicking unsubscribe runs the genuine flow and actually unsubscribes that test
          person, which is the point — the next run's expected count drops by one until you reset
          subscriptions.
        </p>

        {people.length === 0 ? (
          <Card className="p-8 text-center text-sm text-[var(--gray-11)]">
            No test people provisioned yet.
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[260px_320px_1fr]">
            <Card className="p-0 overflow-hidden">
              <div className="px-3 py-2 text-xs uppercase tracking-wide text-[var(--gray-11)] border-b border-[var(--gray-a5)]">
                Recipients
              </div>
              <div className="max-h-[70vh] overflow-y-auto">
                {people.map((person) => (
                  <button
                    key={person.email}
                    type="button"
                    onClick={() => setSelected(person.email)}
                    className={`w-full text-left px-3 py-2 text-sm border-b border-[var(--gray-a5)] hover:bg-[var(--gray-a3)] ${
                      selected === person.email ? 'bg-[var(--accent-a3)]' : ''
                    }`}
                  >
                    <div className="text-[var(--gray-12)] truncate">{person.email}</div>
                    <div className="text-xs text-[var(--gray-11)] flex items-center gap-1">
                      {person.timezone ?? 'no timezone'}
                      {person.subscribed === false && (
                        <Badge color="amber" className="ml-1">
                          unsubscribed
                        </Badge>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </Card>

            <Card className="p-0 overflow-hidden">
              <div className="px-3 py-2 text-xs uppercase tracking-wide text-[var(--gray-11)] border-b border-[var(--gray-a5)]">
                {selectedPerson ? `Inbox — ${selectedPerson.first_name ?? ''}` : 'Inbox'}
              </div>
              {loadingArrivals ? (
                <div className="p-6 flex justify-center">
                  <Spinner />
                </div>
              ) : arrivals.length === 0 ? (
                <div className="p-6 text-sm text-[var(--gray-11)] text-center">
                  Nothing delivered here yet.
                </div>
              ) : (
                <div className="max-h-[70vh] overflow-y-auto">
                  {arrivals.map((arrival) => (
                    <button
                      key={arrival.id}
                      type="button"
                      onClick={() => openMessage(arrival)}
                      className={`w-full text-left px-3 py-2 border-b border-[var(--gray-a5)] hover:bg-[var(--gray-a3)] ${
                        message?.id === arrival.id ? 'bg-[var(--accent-a3)]' : ''
                      }`}
                    >
                      <div className="text-sm text-[var(--gray-12)] truncate">
                        {arrival.subject ?? '(no subject)'}
                      </div>
                      <div className="text-xs text-[var(--gray-11)]">
                        {new Date(arrival.received_at).toLocaleString()}
                        {!arrival.has_body && ' · headers only'}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-0 overflow-hidden">
              <div className="px-3 py-2 text-xs uppercase tracking-wide text-[var(--gray-11)] border-b border-[var(--gray-a5)] flex items-center gap-2">
                <EnvelopeIcon className="h-4 w-4" />
                Message
              </div>
              {!message ? (
                <div className="p-6 text-sm text-[var(--gray-11)] text-center">
                  Select a message to view it.
                </div>
              ) : (
                <div>
                  <div className="px-4 py-3 border-b border-[var(--gray-a5)] space-y-1">
                    <div className="text-sm font-medium text-[var(--gray-12)]">
                      {message.subject ?? '(no subject)'}
                    </div>
                    <div className="text-xs text-[var(--gray-11)]">
                      To {message.recipient_email} ·{' '}
                      {new Date(message.received_at).toLocaleString()}
                    </div>
                    {unsubscribeHeader && (
                      <div className="text-xs text-[var(--gray-11)] break-all">
                        <span className="font-medium">List-Unsubscribe:</span> {unsubscribeHeader}
                        {message.headers_meta?.list_unsubscribe_post ? ' (one-click supported)' : ''}
                      </div>
                    )}
                  </div>
                  {message.body_html ? (
                    <iframe
                      title="Delivered message"
                      // Sandboxed with no allow-scripts and no allow-same-origin: the
                      // body is untrusted content and must not reach the admin origin.
                      // allow-popups keeps links clickable, which is what makes the
                      // unsubscribe test possible.
                      sandbox="allow-popups allow-popups-to-escape-sandbox"
                      srcDoc={message.body_html}
                      className="w-full h-[60vh] bg-white"
                    />
                  ) : (
                    <div className="p-6 text-sm text-[var(--gray-11)]">
                      No body stored for this message.
                    </div>
                  )}
                  <div className="px-4 py-2 border-t border-[var(--gray-a5)] flex justify-end">
                    <Button size="sm" variant="outline" onClick={() => selected && loadArrivals(selected)}>
                      Refresh
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
      </WorkspaceLayout>
    </Page>
  );
}
