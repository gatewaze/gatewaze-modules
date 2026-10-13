/**
 * Shared offer editor: one discount, one code for everyone, valid for one or
 * more events. Visitors reach it at <portal>/offers/<slug>; the portal shows
 * the offer, and reveals the code and records the claim only on a click.
 *
 * Route: /discounts/offers/new and /discounts/offers/:discountId
 * An existing offer opens on its Analytics tab (?tab=analytics|settings);
 * a new one has only the settings form.
 */
import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ArrowLeftIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import { Card, Button, Tabs } from '@/components/ui';
import { Input, Select, Textarea } from '@/components/ui/Form';
import RichTextEditor from '@/components/ui/RichTextEditor';
import { Page } from '@/components/shared/Page';
import { supabase } from '@/lib/supabase';
import { SharedOfferAnalytics } from '../components/SharedOfferAnalytics';

type OfferTab = 'analytics' | 'settings';

interface RegistrationLink {
  event_id: string;
  label: string;
  url: string;
}

interface LinkedEvent {
  event_id: string;
  event_title: string;
  event_link: string | null;
}

interface OfferForm {
  title: string;
  slug: string;
  status: 'active' | 'closed' | 'cancelled';
  close_date: string;
  value: string;
  intro: string;
  content: string;
  ticket_details: string;
  shared_code: string;
  registration_links: RegistrationLink[];
}

const emptyForm: OfferForm = {
  title: '',
  slug: '',
  status: 'active',
  close_date: '',
  value: '',
  intro: '',
  content: '',
  ticket_details: '',
  shared_code: '',
  registration_links: [],
};

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export default function SharedOfferPage() {
  const { discountId } = useParams<{ discountId: string }>();
  const navigate = useNavigate();
  const isNew = !discountId || discountId === 'new';

  const [form, setForm] = useState<OfferForm>(emptyForm);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [events, setEvents] = useState<Record<string, LinkedEvent>>({});
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab: OfferTab = isNew ? 'settings' : (searchParams.get('tab') === 'settings' ? 'settings' : 'analytics');
  const setActiveTab = (tab: OfferTab) => setSearchParams({ tab }, { replace: true });
  const [portalBase, setPortalBase] = useState<string>('');

  useEffect(() => {
    supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'domain')
      .maybeSingle()
      .then(({ data }: { data: { value: string } | null }) => {
        const v = (data?.value || '').trim();
        if (v) setPortalBase(v.startsWith('http') ? v.replace(/\/$/, '') : `https://${v}`);
      });
  }, []);

  useEffect(() => {
    if (isNew) return;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('events_discounts')
        .select('id, title, slug, status, close_date, value, intro, content, ticket_details, registration_links')
        .eq('id', discountId)
        .maybeSingle();
      if (error || !data) {
        toast.error('Offer not found');
        setLoading(false);
        return;
      }
      const { data: secret } = await supabase
        .from('events_discount_secrets')
        .select('shared_code')
        .eq('discount_id', discountId)
        .maybeSingle();
      const links: RegistrationLink[] = Array.isArray(data.registration_links)
        ? data.registration_links.map((l: Partial<RegistrationLink>) => ({
            event_id: l.event_id || '',
            label: l.label || '',
            url: l.url || '',
          }))
        : [];
      setForm({
        title: data.title || '',
        slug: data.slug || '',
        status: (data.status as OfferForm['status']) || 'active',
        close_date: toLocalInput(data.close_date),
        value: data.value || '',
        intro: data.intro || '',
        content: data.content || '',
        ticket_details: data.ticket_details || '',
        shared_code: secret?.shared_code || '',
        registration_links: links,
      });
      await lookupEvents(links.map((l) => l.event_id));
      setLoading(false);
    })();
  }, [discountId, isNew]);

  const lookupEvents = async (ids: string[]) => {
    const wanted = ids.filter((id) => EVENT_ID_RE.test(id));
    if (wanted.length === 0) return;
    const { data } = await supabase
      .from('events')
      .select('event_id, event_title, event_link')
      .in('event_id', wanted);
    setEvents((prev) => {
      const next = { ...prev };
      for (const e of (data || []) as LinkedEvent[]) next[e.event_id] = e;
      return next;
    });
  };

  const updateLink = (i: number, patch: Partial<RegistrationLink>) => {
    setForm((f) => ({
      ...f,
      registration_links: f.registration_links.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    }));
  };

  const validate = (): string | null => {
    if (!form.title.trim()) return 'Title is required';
    if (!SLUG_RE.test(form.slug)) return 'Slug may only contain lowercase letters, numbers and hyphens';
    if (!form.shared_code.trim()) return 'Enter the discount code';
    if (form.shared_code.trim().length > 100) return 'The discount code is too long';
    if (form.registration_links.length === 0) return 'Add at least one event';
    for (const l of form.registration_links) {
      if (!EVENT_ID_RE.test(l.event_id) || !events[l.event_id]) return `Unknown event id "${l.event_id}"`;
      if (l.url && !isHttpUrl(l.url)) return `"${l.url}" is not a web address`;
    }
    return null;
  };

  const handleSave = async () => {
    const problem = validate();
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    try {
      const row = {
        title: form.title.trim(),
        slug: form.slug,
        status: form.status,
        close_date: form.close_date ? new Date(form.close_date).toISOString() : null,
        value: form.value.trim() || null,
        intro: form.intro.trim() || null,
        content: form.content || null,
        ticket_details: form.ticket_details.trim() || null,
        registration_links: form.registration_links.map((l) => ({
          event_id: l.event_id,
          ...(l.label.trim() ? { label: l.label.trim() } : {}),
          ...(l.url.trim() ? { url: l.url.trim() } : {}),
        })),
        // Not tied to one event; shown on /offers/<slug>, not an event tab.
        event_id: null,
        hidden: true,
      };

      let id = discountId;
      if (isNew) {
        const { data, error } = await supabase.from('events_discounts').insert(row).select('id').single();
        if (error) throw error;
        id = data.id;
      } else {
        const { error } = await supabase.from('events_discounts').update(row).eq('id', discountId);
        if (error) throw error;
      }

      const { error: secretError } = await supabase
        .from('events_discount_secrets')
        .upsert({ discount_id: id, shared_code: form.shared_code.trim() }, { onConflict: 'discount_id' });
      if (secretError) throw secretError;

      toast.success('Offer saved');
      if (isNew) navigate(`/discounts/offers/${id}?tab=settings`, { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String((err as { message?: string })?.message ?? err);
      toast.error(msg.includes('uq_events_discounts_slug') ? 'Another discount already uses this slug' : `Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const offerUrl = form.slug && portalBase ? `${portalBase}/offers/${form.slug}` : '';

  if (loading) {
    return (
      <Page title="Shared offer">
        <div className="p-6 text-sm text-gray-500">Loading…</div>
      </Page>
    );
  }

  return (
    <Page title={isNew ? 'New shared offer' : `Shared offer – ${form.title}`}>
      <div className="p-6 space-y-6">
        <Button variant="outline" onClick={() => navigate('/discounts')}>
          <ArrowLeftIcon className="w-4 h-4 mr-1" />
          Back to discounts
        </Button>

        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">{isNew ? 'New shared offer' : form.title}</h1>
          {offerUrl && !isNew && (
            <a href={offerUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:underline whitespace-nowrap">
              Open offer page
            </a>
          )}
        </div>

        {!isNew && (
          <Tabs
            value={activeTab}
            onChange={(tab: string) => setActiveTab(tab as OfferTab)}
            tabs={[
              { id: 'analytics', label: 'Analytics' },
              { id: 'settings', label: 'Settings' },
            ]}
          />
        )}

        {activeTab === 'analytics' && discountId && !isNew ? (
          <SharedOfferAnalytics discountId={discountId} slug={form.slug} />
        ) : (
        <div className="space-y-6 max-w-3xl">
        <Card className="p-6 space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Everyone who claims this offer gets the same code. The offer page shows the offer when it is opened,
            and only reveals the code, and records the claim, when the visitor clicks. Link to it from an email as{' '}
            <code className="text-xs">{offerUrl || '<portal>/offers/<slug>'}?utm_medium={'{{email_encoded}}'}</code>{' '}
            so claims are recorded against the recipient.
          </p>
          <Input
            label="Title"
            value={form.title}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              const title = e.target.value;
              setForm((f) => ({ ...f, title, slug: isNew && (!f.slug || f.slug === slugify(f.title)) ? slugify(title) : f.slug }));
            }}
            placeholder="e.g. Free tickets: PyTorch Conference and AGNTCon + MCPCon NA"
          />
          <Input
            label="Slug"
            value={form.slug}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
            placeholder="e.g. free-tickets-pytorch-agntcon-2026"
          />
          <Input
            label="Discount code"
            value={form.shared_code}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, shared_code: e.target.value })}
            placeholder="The single code everyone receives"
          />
          <Input
            label="Value"
            value={form.value}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, value: e.target.value })}
            placeholder="e.g. Free ticket"
          />
          <Input
            label="Ticket details"
            value={form.ticket_details}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, ticket_details: e.target.value })}
            placeholder="e.g. Full conference pass"
          />
          <Textarea
            label="Intro"
            value={form.intro}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setForm({ ...form, intro: e.target.value })}
            rows={3}
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Content</label>
            <RichTextEditor
              content={form.content}
              onChange={(content: string) => setForm({ ...form, content })}
              placeholder="Details shown on the offer page"
            />
          </div>
          <Input
            label="Close date"
            type="datetime-local"
            value={form.close_date}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, close_date: e.target.value })}
          />
          <Select
            label="Status"
            value={form.status}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setForm({ ...form, status: e.target.value as OfferForm['status'] })}
            data={[
              { label: 'Active', value: 'active' },
              { label: 'Closed', value: 'closed' },
              { label: 'Cancelled', value: 'cancelled' },
            ]}
          />
        </Card>

        <Card className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold">Events</h3>
            <Button
              variant="secondary"
              size="small"
              onClick={() => setForm((f) => ({ ...f, registration_links: [...f.registration_links, { event_id: '', label: '', url: '' }] }))}
            >
              <PlusIcon className="w-4 h-4 mr-1" />
              Add event
            </Button>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Each event gets a register button on the offer page. Leave the URL blank to use the event's own link.
          </p>
          {form.registration_links.map((link, i) => {
            const ev = events[link.event_id];
            return (
              <div key={i} className="rounded-md border border-gray-200 dark:border-gray-700 p-4 space-y-3">
                <div className="flex items-end gap-3">
                  <div className="flex-1">
                    <Input
                      label="Event ID"
                      value={link.event_id}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateLink(i, { event_id: e.target.value.trim() })}
                      onBlur={() => lookupEvents([link.event_id])}
                      placeholder="e.g. tu1641"
                    />
                  </div>
                  <Button
                    variant="danger"
                    size="small"
                    onClick={() => setForm((f) => ({ ...f, registration_links: f.registration_links.filter((_, j) => j !== i) }))}
                  >
                    <TrashIcon className="w-4 h-4" />
                  </Button>
                </div>
                <p className="text-xs text-gray-500">
                  {link.event_id ? (ev ? ev.event_title : 'No event with this ID') : 'Enter the short event ID from the event URL'}
                </p>
                <Input
                  label="Button label (optional)"
                  value={link.label}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateLink(i, { label: e.target.value })}
                  placeholder={ev ? `Register for ${ev.event_title}` : ''}
                />
                <Input
                  label="Registration URL (optional)"
                  value={link.url}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateLink(i, { url: e.target.value })}
                  placeholder={ev?.event_link || 'https://…'}
                />
              </div>
            );
          })}
        </Card>

        <div className="flex gap-3">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create offer' : 'Save offer'}
          </Button>
        </div>
        </div>
        )}
      </div>
    </Page>
  );
}
