import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Card, Button, Badge } from '@/components/ui';
import { supabase } from '@/lib/supabase';

const ACCENT_COLORS = [
  '#00a2c7', '#0e7490', '#059669', '#7c3aed', '#dc2626',
  '#ea580c', '#d97706', '#2563eb', '#4f46e5', '#be185d',
];

interface Newsletter {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  content_category: string | null;
  accent_color: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  list_id: string | null;
  setup_complete: boolean;
  require_login: boolean;
}

interface Props {
  newsletter: Newsletter;
  onSave: () => void;
}

export function NewsletterDetailsForm({ newsletter, onSave }: Props) {
  const [form, setForm] = useState({ ...newsletter });
  const [saving, setSaving] = useState(false);
  const [lists, setLists] = useState<Array<{ id: string; name: string }>>([]);
  const [categories, setCategories] = useState<Array<{ value: string; label: string }>>([]);

  useEffect(() => {
    supabase.from('lists').select('id, name').eq('is_active', true).order('name')
      .then(({ data }) => setLists(data || []))
      .catch(() => {});

    supabase.from('platform_settings').select('value').eq('key', 'content_categories').maybeSingle()
      .then(({ data }) => {
        if (data?.value) try { setCategories(JSON.parse(data.value)); } catch {}
      });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from('newsletters_template_collections')
        .update({
          name: form.name,
          description: form.description || null,
          content_category: form.content_category || null,
          accent_color: form.accent_color,
          from_name: form.from_name || null,
          from_email: form.from_email || null,
          reply_to: form.reply_to || null,
          forward_replies_to: form.forward_replies_to || null,
          list_id: form.list_id || null,
          require_login: form.require_login || false,
          updated_at: new Date().toISOString(),
        })
        .eq('id', newsletter.id);

      if (error) throw error;
      toast.success('Newsletter settings saved');
      onSave();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full px-3 py-2 text-sm border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]";

  return (
    <div className="max-w-2xl space-y-6">
      <Card variant="surface" className="p-6">
        <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-4">General</h2>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Name *</label>
              <input value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Slug</label>
              <input value={form.slug} readOnly className={`${inputClass} bg-[var(--gray-a2)] font-mono`} />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Description</label>
            <textarea value={form.description || ''} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} className={inputClass} rows={2} />
          </div>
          {categories.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Content Category</label>
              <select value={form.content_category || ''} onChange={(e) => setForm(f => ({ ...f, content_category: e.target.value }))} className={inputClass}>
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
                  onClick={() => setForm(f => ({ ...f, accent_color: color }))}
                  className={`w-8 h-8 rounded-full border-2 transition-transform ${form.accent_color === color ? 'border-[var(--gray-12)] scale-110' : 'border-transparent'}`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Card variant="surface" className="p-6">
        <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-4">Sender Identity</h2>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">From Name</label>
              <input value={form.from_name || ''} onChange={(e) => setForm(f => ({ ...f, from_name: e.target.value }))} className={inputClass} placeholder="AAIF Newsletter" />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">From Email</label>
              <input type="email" value={form.from_email || ''} onChange={(e) => setForm(f => ({ ...f, from_email: e.target.value }))} className={inputClass} placeholder="newsletter@aaif.io" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Reply-To Email</label>
              <input type="email" value={form.reply_to || ''} onChange={(e) => setForm(f => ({ ...f, reply_to: e.target.value }))} className={inputClass} placeholder="hello@aaif.io" />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Forward Replies To</label>
              <input type="email" value={form.forward_replies_to || ''} onChange={(e) => setForm(f => ({ ...f, forward_replies_to: e.target.value }))} className={inputClass} placeholder="team@aaif.io" />
              <p className="text-xs text-[var(--gray-9)] mt-1">Inbound replies are forwarded to this address</p>
            </div>
          </div>
        </div>
      </Card>

      <Card variant="surface" className="p-6">
        <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-4">Subscription List</h2>
        <div className="space-y-4">
          {lists.length > 0 ? (
            <select value={form.list_id || ''} onChange={(e) => setForm(f => ({ ...f, list_id: e.target.value }))} className={inputClass}>
              <option value="">No list linked</option>
              {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          ) : (
            <p className="text-sm text-[var(--gray-9)]">No subscription lists available. Create one in the Lists section.</p>
          )}
          <label className="flex items-center gap-2 text-sm text-[var(--gray-11)]">
            <input
              type="checkbox"
              checked={form.require_login || false}
              onChange={(e) => setForm(f => ({ ...f, require_login: e.target.checked }))}
              className="rounded"
            />
            Subscribers only — require login to view editions on the portal
          </label>
        </div>
      </Card>

      <Button variant="solid" onClick={handleSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save Settings'}
      </Button>
    </div>
  );
}
