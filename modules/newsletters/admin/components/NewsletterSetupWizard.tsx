import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  CheckIcon,
  EnvelopeIcon,
  PaintBrushIcon,
  QueueListIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge, Modal } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { supabase } from '@/lib/supabase';

interface WizardData {
  name: string;
  slug: string;
  description: string;
  content_category: string;
  accent_color: string;
  from_name: string;
  from_email: string;
  reply_to: string;
  list_id: string;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Per spec-builder-evaluation §3.6 (extended). The "Template" step was
// removed — every newsletter automatically clones the email boilerplate
// (gatewaze-template-email by default; override via
// GATEWAZE_NEWSLETTER_BOILERPLATE_URL) on creation and stamps the four
// react-email registry blocks (header / content_section / ai_section /
// footer). Operators can swap to a custom boilerplate or graduate to
// an external repo from the channel's Source tab afterwards.
const STEPS = [
  { id: 'basics', label: 'Basics', icon: PaintBrushIcon },
  { id: 'sender', label: 'Sender', icon: EnvelopeIcon },
  { id: 'list', label: 'List', icon: QueueListIcon },
];

const ACCENT_COLORS = [
  '#00a2c7', '#0e7490', '#059669', '#7c3aed', '#dc2626',
  '#ea580c', '#d97706', '#2563eb', '#4f46e5', '#be185d',
];

interface WizardProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export default function NewsletterSetupWizard({ isOpen = true, onClose }: WizardProps = {}) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [lists, setLists] = useState<Array<{ id: string; name: string; slug: string }>>([]);
  const [categories, setCategories] = useState<Array<{ value: string; label: string }>>([]);

  const [data, setData] = useState<WizardData>({
    name: '', slug: '', description: '', content_category: '',
    accent_color: '#00a2c7', from_name: '', from_email: '',
    reply_to: '', list_id: '',
  });

  useEffect(() => {
    // Load lists
    supabase.from('lists').select('id, name, slug').eq('is_active', true).order('name')
      .then(({ data }) => setLists(data || []))
      .catch(() => {});

    // Load content categories
    supabase.from('platform_settings').select('value').eq('key', 'content_categories').maybeSingle()
      .then(({ data }) => {
        if (data?.value) {
          try { setCategories(JSON.parse(data.value)); } catch {}
        }
      });

  }, []);

  const updateField = (field: keyof WizardData, value: string) => {
    setData(prev => ({
      ...prev,
      [field]: value,
      ...(field === 'name' && !prev.slug ? { slug: slugify(value) } : {}),
    }));
  };

  const canProceed = () => {
    switch (step) {
      case 0: return data.name.trim().length > 0;
      case 1: return data.from_name.trim().length > 0 && data.from_email.trim().length > 0;
      case 2: return true; // list is optional
      default: return false;
    }
  };

  const handleCreate = async () => {
    setSaving(true);
    try {
      // Create the newsletter (template collection)
      const { data: newsletter, error } = await supabase
        .from('newsletters_template_collections')
        .insert({
          name: data.name,
          slug: data.slug || slugify(data.name),
          description: data.description || null,
          content_category: data.content_category || null,
          accent_color: data.accent_color,
          from_name: data.from_name,
          from_email: data.from_email,
          reply_to: data.reply_to || null,
          list_id: data.list_id || null,
          setup_complete: true,
        })
        .select()
        .single();

      if (error) throw error;

      // Provision the corresponding templates_libraries row. Per migration
      // 021's mapping, library.id == collection.id == library.host_id.
      // host_kind='newsletter' so the templates RLS hooks know which
      // can_admin_* helper to invoke.
      //
      // Previously this insert had no error handling — if RLS denied
      // it (e.g., the can_admin_newsletter helper hadn't seen the new
      // collection row yet), the wizard reported success but every
      // downstream operation that joins through templates_libraries
      // (creating a source, seeding from boilerplate, listing block
      // defs) would FK-violation. Surface the failure here so the
      // operator either gets a real error toast or the wizard
      // restarts cleanly.
      const { error: libraryError } = await supabase
        .from('templates_libraries')
        .insert({
          id: newsletter.id,
          host_kind: 'newsletter',
          host_id: newsletter.id,
          name: data.name,
          description: data.description || null,
          theme_kind: 'email',
        });
      if (libraryError) {
        // eslint-disable-next-line no-console
        console.error('[newsletter-setup] templates_libraries insert failed:', libraryError);
        throw new Error(
          `Failed to provision template library for newsletter: ${libraryError.message}`,
        );
      }

      // Per spec-builder-evaluation §3.6 (extended). Every newsletter is
      // created with the four "basic template" react-email blocks
      // pre-registered against its templates_library. The components
      // themselves live in the platform's email-blocks registry; the DB
      // rows here are pointers (render_kind='react-email' + component_id)
      // that the editor's loader filters into the palette. The full
      // platform registry remains available — these four are the
      // sensible defaults that match the boilerplate's manifest.json.
      const basicComponentIds = ['header', 'content_section', 'ai_section', 'footer'];
      for (const componentId of basicComponentIds) {
        await supabase.from('templates_block_defs').insert({
          library_id: newsletter.id,
          key: componentId,
          name: componentId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          description: null,
          source_kind: 'static',
          html: '',
          rich_text_template: '',
          has_bricks: false,
          schema: {},
          version: 1,
          is_current: true,
          render_kind: 'react-email',
          component_id: componentId,
        });
      }

      // Per spec-builder-evaluation §3.6 (extended). Eager boilerplate
      // clone — fire the init-repo endpoint so the channel's bare repo
      // is provisioned at creation time (matches sites' behaviour). The
      // endpoint is best-effort: when the resolved boilerplate URL is
      // empty (GATEWAZE_NEWSLETTER_BOILERPLATE_URL explicitly cleared)
      // OR the clone fails (network / auth / missing repo), it returns
      // 200 { kind: 'skipped' | 'failed' } and the wizard proceeds. A
      // retry is available from the channel's Source tab once the
      // cause is fixed.
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        const initRes = await fetch(
          `/api/admin/newsletters/collections/${newsletter.id}/init-repo`,
          {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
          },
        );
        if (initRes.ok) {
          const body = (await initRes.json().catch(() => null)) as { kind?: string; message?: string; reason?: string } | null;
          if (body?.kind === 'initialised') {
            toast.success('Boilerplate cloned to internal git repo');
          } else if (body?.kind === 'failed') {
            toast.warning(`Boilerplate clone deferred: ${body.message ?? 'unknown'}`);
          }
          // 'skipped' is silent — common in dev when env isn't set.
        }
      } catch (initErr) {
        // eslint-disable-next-line no-console
        console.warn('[wizard] init-repo failed:', initErr);
      }

      toast.success(`Newsletter "${data.name}" created!`);
      navigate(`/newsletters/${newsletter.slug}`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create newsletter');
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full px-3 py-2 text-sm border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]";

  const handleClose = () => {
    if (onClose) onClose();
    else navigate('/newsletters');
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Create Newsletter"
      size="xl"
      footer={
        <div className="flex items-center justify-between w-full">
          <Button variant="outline" onClick={() => step > 0 ? setStep(step - 1) : handleClose()} disabled={saving}>
            {step === 0 ? 'Cancel' : 'Back'}
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--gray-9)]">Step {step + 1} of {STEPS.length}</span>
            {step < STEPS.length - 1 ? (
              <Button variant="solid" onClick={() => setStep(step + 1)} disabled={!canProceed()}>
                Next
              </Button>
            ) : (
              <Button variant="solid" onClick={handleCreate} disabled={saving || !data.name.trim()}>
                {saving ? 'Creating...' : 'Create Newsletter'}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-8">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const isActive = i === step;
            const isDone = i < step;
            return (
              <div key={s.id} className="flex items-center gap-2 flex-1">
                <div className={`flex items-center justify-center w-8 h-8 rounded-full shrink-0 ${
                  isDone ? 'bg-green-500 text-white' : isActive ? 'bg-[var(--accent-9)] text-white' : 'bg-[var(--gray-a4)] text-[var(--gray-9)]'
                }`}>
                  {isDone ? <CheckIcon className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
                </div>
                <span className={`text-sm font-medium ${isActive ? 'text-[var(--gray-12)]' : 'text-[var(--gray-9)]'}`}>
                  {s.label}
                </span>
                {i < STEPS.length - 1 && <div className="flex-1 h-px bg-[var(--gray-a5)]" />}
              </div>
            );
          })}
        </div>

        {/* Step content */}
        <Card variant="surface" className="p-6 mb-6">
          {step === 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-[var(--gray-12)]">Newsletter Basics</h2>
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Newsletter Name *</label>
                <input value={data.name} onChange={(e) => updateField('name', e.target.value)} className={inputClass} placeholder="EXAMPLE Weekly" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Slug</label>
                <input value={data.slug} onChange={(e) => updateField('slug', slugify(e.target.value))} className={`${inputClass} font-mono`} placeholder="example-weekly" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Description</label>
                <textarea value={data.description} onChange={(e) => updateField('description', e.target.value)} className={inputClass} rows={2} placeholder="Weekly updates from the EXAMPLE community" />
              </div>
              {categories.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Content Category</label>
                  <select value={data.content_category} onChange={(e) => updateField('content_category', e.target.value)} className={inputClass}>
                    <option value="">No category</option>
                    {categories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">Accent Color</label>
                <div className="flex gap-2">
                  {ACCENT_COLORS.map(color => (
                    <button
                      key={color}
                      onClick={() => updateField('accent_color', color)}
                      className={`w-8 h-8 rounded-full border-2 transition-transform ${data.accent_color === color ? 'border-[var(--gray-12)] scale-110' : 'border-transparent'}`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-[var(--gray-12)]">Sender Identity</h2>
              <p className="text-sm text-[var(--gray-9)]">This is how your newsletter will appear in recipients' inboxes.</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">From Name *</label>
                  <input value={data.from_name} onChange={(e) => updateField('from_name', e.target.value)} className={inputClass} placeholder="EXAMPLE Newsletter" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">From Email *</label>
                  <input type="email" value={data.from_email} onChange={(e) => updateField('from_email', e.target.value)} className={inputClass} placeholder="newsletter@example.io" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Reply-To Email</label>
                <input type="email" value={data.reply_to} onChange={(e) => updateField('reply_to', e.target.value)} className={inputClass} placeholder="hello@example.io" />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-[var(--gray-12)]">Subscription List</h2>
              <p className="text-sm text-[var(--gray-9)]">Link a subscription list to manage who receives this newsletter.</p>
              {lists.length > 0 ? (
                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Select List</label>
                  <select value={data.list_id} onChange={(e) => updateField('list_id', e.target.value)} className={inputClass}>
                    <option value="">No list (configure later)</option>
                    {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </div>
              ) : (
                <div className="p-4 bg-[var(--gray-a2)] rounded-lg">
                  <p className="text-sm text-[var(--gray-11)]">No subscription lists available. You can create one in the Lists section and link it later.</p>
                </div>
              )}
            </div>
          )}

        </Card>

      </div>
    </Modal>
  );
}
