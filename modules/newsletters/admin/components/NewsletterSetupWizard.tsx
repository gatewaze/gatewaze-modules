import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  CheckIcon,
  EnvelopeIcon,
  PaintBrushIcon,
  QueueListIcon,
  DocumentArrowUpIcon,
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

const STEPS = [
  { id: 'basics', label: 'Basics', icon: PaintBrushIcon },
  { id: 'sender', label: 'Sender', icon: EnvelopeIcon },
  { id: 'list', label: 'List', icon: QueueListIcon },
  { id: 'template', label: 'Template', icon: DocumentArrowUpIcon },
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
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [templateSource, setTemplateSource] = useState<'basic' | 'blank' | 'upload' | 'clone'>('basic');
  const [cloneFrom, setCloneFrom] = useState('');
  const [existingNewsletters, setExistingNewsletters] = useState<Array<{ id: string; name: string }>>([]);

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

    // Load existing newsletters for cloning
    supabase.from('newsletters_template_collections').select('id, name').order('name')
      .then(({ data }) => setExistingNewsletters(data || []));
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
      case 3: return true; // template is optional (can start blank)
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
      await supabase.from('templates_libraries').insert({
        id: newsletter.id,
        host_kind: 'newsletter',
        host_id: newsletter.id,
        name: data.name,
        description: data.description || null,
        theme_kind: 'email',
      });

      // Generate basic template with default blocks (writes to templates_block_defs).
      if (templateSource === 'basic') {
        const basicBlocks = [
          {
            library_id: newsletter.id,
            key: 'header',
            name: 'Header',
            description: null,
            source_kind: 'static',
            html: '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding: 30px 40px; background-color: #f8f9fa; text-align: center;"><h1 style="margin: 0; font-size: 28px; font-weight: bold; color: #1a1a2e;">{{title}}</h1>{{#subtitle}}<p style="margin: 8px 0 0; font-size: 16px; color: #666;">{{subtitle}}</p>{{/subtitle}}</td></tr></table>',
            rich_text_template: '<h1>{{title}}</h1>\n{{#subtitle}}<p>{{subtitle}}</p>{{/subtitle}}',
            has_bricks: false,
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string', title: 'Title' },
                subtitle: { type: 'string', title: 'Subtitle' },
              },
            },
            version: 1,
            is_current: true,
          },
          {
            library_id: newsletter.id,
            key: 'content_section',
            name: 'Content Section',
            description: null,
            source_kind: 'static',
            html: '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding: 20px 40px;">{{#title}}<h2 style="font-size: 22px; font-weight: bold; color: #1a1a2e; margin: 0 0 16px;">{{title}}</h2>{{/title}}<div style="font-size: 16px; line-height: 1.6; color: #333;">{{body}}</div></td></tr></table>',
            rich_text_template: '{{#title}}<h2>{{title}}</h2>{{/title}}\n{{body}}',
            has_bricks: false,
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string', title: 'Section Title' },
                body: { type: 'string', format: 'html', title: 'Content' },
              },
            },
            version: 1,
            is_current: true,
          },
          {
            library_id: newsletter.id,
            key: 'ai_section',
            name: 'AI Content Section',
            description: null,
            source_kind: 'static',
            html: '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding: 20px 40px;">{{#title}}<h2 style="font-size: 22px; font-weight: bold; color: #1a1a2e; margin: 0 0 16px;">{{title}}</h2>{{/title}}<div style="font-size: 16px; line-height: 1.6; color: #333;">{{ai_body}}</div></td></tr></table>',
            rich_text_template: '{{#title}}<h2>{{title}}</h2>{{/title}}\n{{ai_body}}',
            has_bricks: false,
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string', title: 'Section Title' },
                ai_body: {
                  type: 'string',
                  format: 'ai_content',
                  title: 'Content',
                  'x-ai-config': {
                    systemPrompt: 'You are writing a section for a newsletter. Write engaging, informative content. Use clear headings and keep the tone professional yet accessible.',
                    maxTokens: 2000,
                  },
                },
              },
            },
            version: 1,
            is_current: true,
          },
          {
            library_id: newsletter.id,
            key: 'footer',
            name: 'Footer',
            description: null,
            source_kind: 'static',
            html: '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding: 20px 40px; background-color: #f8f9fa; text-align: center; font-size: 13px; color: #999;"><p style="margin: 0;">{{footer_text}}</p>{{#unsubscribe_text}}<p style="margin: 8px 0 0;"><a href="{{unsubscribe_link}}" style="color: #666;">{{unsubscribe_text}}</a></p>{{/unsubscribe_text}}</td></tr></table>',
            rich_text_template: '<p style="text-align:center;color:#999">{{footer_text}}</p>',
            has_bricks: false,
            schema: {
              type: 'object',
              properties: {
                footer_text: { type: 'string', title: 'Footer Text' },
                unsubscribe_text: { type: 'string', title: 'Unsubscribe Link Text' },
                unsubscribe_link: { type: 'string', format: 'uri', title: 'Unsubscribe URL' },
              },
            },
            version: 1,
            is_current: true,
          },
        ];

        for (const block of basicBlocks) {
          await supabase.from('templates_block_defs').insert(block);
        }
      }

      // Clone templates from another library if requested.
      if (templateSource === 'clone' && cloneFrom) {
        const { data: blocks } = await supabase
          .from('templates_block_defs')
          .select('*')
          .eq('library_id', cloneFrom);

        // Map of old block_def_id → new block_def_id so we can re-parent bricks.
        const blockIdRemap = new Map<string, string>();

        for (const block of blocks || []) {
          const { id: oldId, library_id: __, created_at: ___, updated_at: ____, ...blockData } = block;
          const { data: inserted } = await supabase
            .from('templates_block_defs')
            .insert({ ...blockData, library_id: newsletter.id })
            .select('id')
            .single();
          if (inserted?.id) blockIdRemap.set(oldId, inserted.id);
        }

        // Bricks are parented by block_def_id. Filter via inner-embed on the
        // parent library. Note: this returns rows including the join object;
        // we strip it before insert.
        const { data: bricks } = await supabase
          .from('templates_brick_defs')
          .select('*, templates_block_defs!inner(library_id)')
          .eq('templates_block_defs.library_id', cloneFrom);

        for (const brick of bricks || []) {
          const { id: _, block_def_id: oldParent, created_at: ___, updated_at: ____, templates_block_defs: _____, ...brickData } = brick;
          const newParent = blockIdRemap.get(oldParent);
          if (!newParent) continue;
          await supabase.from('templates_brick_defs').insert({
            ...brickData,
            block_def_id: newParent,
          });
        }
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
                <input value={data.name} onChange={(e) => updateField('name', e.target.value)} className={inputClass} placeholder="AAIF Weekly" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Slug</label>
                <input value={data.slug} onChange={(e) => updateField('slug', slugify(e.target.value))} className={`${inputClass} font-mono`} placeholder="aaif-weekly" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Description</label>
                <textarea value={data.description} onChange={(e) => updateField('description', e.target.value)} className={inputClass} rows={2} placeholder="Weekly updates from the AAIF community" />
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
                  <input value={data.from_name} onChange={(e) => updateField('from_name', e.target.value)} className={inputClass} placeholder="AAIF Newsletter" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">From Email *</label>
                  <input type="email" value={data.from_email} onChange={(e) => updateField('from_email', e.target.value)} className={inputClass} placeholder="newsletter@aaif.io" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Reply-To Email</label>
                <input type="email" value={data.reply_to} onChange={(e) => updateField('reply_to', e.target.value)} className={inputClass} placeholder="hello@aaif.io" />
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

          {step === 3 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-[var(--gray-12)]">Template</h2>
              <p className="text-sm text-[var(--gray-9)]">Choose how to set up your newsletter template.</p>
              <div className="space-y-3">
                {[
                  { id: 'basic' as const, label: 'Basic template (recommended)', desc: 'Creates a ready-to-use template with header, content sections, AI content sections, and footer blocks' },
                  { id: 'upload' as const, label: 'Upload custom HTML template', desc: 'Upload an HTML file with block comments for a fully custom design' },
                  ...(existingNewsletters.length > 0 ? [{ id: 'clone' as const, label: 'Clone from existing newsletter', desc: 'Copy templates from another newsletter' }] : []),
                  { id: 'blank' as const, label: 'Start blank', desc: 'No blocks — add them manually later' },
                ].map(opt => (
                  <label key={opt.id} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    templateSource === opt.id ? 'border-[var(--accent-9)] bg-[var(--accent-2)]' : 'border-[var(--gray-a5)] hover:bg-[var(--gray-a2)]'
                  }`}>
                    <input type="radio" checked={templateSource === opt.id} onChange={() => setTemplateSource(opt.id)} className="mt-1" />
                    <div>
                      <p className="text-sm font-medium text-[var(--gray-12)]">{opt.label}</p>
                      <p className="text-xs text-[var(--gray-9)]">{opt.desc}</p>
                    </div>
                  </label>
                ))}
              </div>

              {templateSource === 'clone' && existingNewsletters.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Clone from</label>
                  <select value={cloneFrom} onChange={(e) => setCloneFrom(e.target.value)} className={inputClass}>
                    <option value="">Select newsletter...</option>
                    {existingNewsletters.map(nl => <option key={nl.id} value={nl.id}>{nl.name}</option>)}
                  </select>
                </div>
              )}

              {templateSource === 'upload' && (
                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">HTML Template File</label>
                  <input type="file" accept=".html,.htm" onChange={(e) => setTemplateFile(e.target.files?.[0] || null)} className="text-sm" />
                  <p className="text-xs text-[var(--gray-9)] mt-1">You can upload the template after creation via the Template tab.</p>
                </div>
              )}
            </div>
          )}
        </Card>

      </div>
    </Modal>
  );
}
