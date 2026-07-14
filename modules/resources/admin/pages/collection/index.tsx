import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  PlusIcon,
  PencilIcon,
  TrashIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  TagIcon,
  DocumentTextIcon,
  RectangleGroupIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline';
import { Button, Card, Badge, Input, Select, WorkspaceLayout } from '@/components/ui';
import type { Tab } from '@/components/ui/Tabs';
import RichTextEditor from '@/components/ui/RichTextEditor';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import {
  SrCollection,
  SrCategory,
  SrItem,
  SrSection,
  SrSectionTemplate,
  CollectionsService,
  CategoriesService,
  ItemsService,
  SectionsService,
  SectionTemplatesService,
  generateCover,
  uploadCoverImage,
} from '../../utils/structuredResourcesService';

// ============================================================
// Main component
// ============================================================

export default function CollectionDetailPage() {
  const { id, tab } = useParams<{ id: string; tab?: string }>();
  const navigate = useNavigate();

  const validTabs = ['categories', 'items', 'templates', 'settings'] as const;
  type TabType = typeof validTabs[number];
  const activeTab: TabType = (tab && validTabs.includes(tab as TabType)) ? tab as TabType : 'categories';

  const navigateToTab = (newTab: TabType) => {
    navigate(`/resources/collections/${id}/${newTab}`);
  };

  // Data
  const [collection, setCollection] = useState<SrCollection | null>(null);
  const [categories, setCategories] = useState<SrCategory[]>([]);
  const [items, setItems] = useState<SrItem[]>([]);
  const [templates, setTemplates] = useState<SrSectionTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [colRes, catRes, itemRes, tplRes] = await Promise.all([
        CollectionsService.getById(id),
        CategoriesService.getByCollection(id),
        ItemsService.getByCollection(id),
        SectionTemplatesService.getByCollection(id),
      ]);
      if (colRes.success && colRes.data) setCollection(colRes.data);
      if (catRes.success && catRes.data) setCategories(catRes.data);
      if (itemRes.success && itemRes.data) setItems(itemRes.data);
      if (tplRes.success && tplRes.data) setTemplates(tplRes.data);
    } catch {
      toast.error('Failed to load collection data');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadData(); }, [loadData]);

  const ic = 'h-4 w-4';
  const tabs: Tab[] = [
    { id: 'categories', label: 'Categories', count: categories.length, icon: <TagIcon className={ic} /> },
    { id: 'items', label: 'Items', count: items.length, icon: <DocumentTextIcon className={ic} /> },
    { id: 'templates', label: 'Section Templates', count: templates.length, icon: <RectangleGroupIcon className={ic} /> },
    { id: 'settings', label: 'Settings', icon: <Cog6ToothIcon className={ic} /> },
  ];

  if (loading) {
    return (
      <Page title="Resources">
        <WorkspaceLayout title="Resources">
          <div className="flex justify-center items-center py-12">
            <LoadingSpinner size="large" />
          </div>
        </WorkspaceLayout>
      </Page>
    );
  }

  if (!collection) {
    return (
      <Page title="Resources">
        <WorkspaceLayout title="Resources">
          <Card className="p-12 text-center">
            <p className="text-[var(--gray-11)] mb-4">Collection not found</p>
            <Button onClick={() => navigate('/resources/collections')}>Back to Collections</Button>
          </Card>
        </WorkspaceLayout>
      </Page>
    );
  }

  const statusColor = (s: string) => s === 'published' ? 'success' : s === 'draft' ? 'warning' : 'neutral';

  return (
    <Page title={collection.name}>
      <WorkspaceLayout
        title={`Resources: ${collection.name}`}
        tabs={tabs}
        activeTabId={activeTab}
        onTabChange={(t) => navigateToTab(t as TabType)}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <Badge color={statusColor(collection.status)}>{collection.status}</Badge>
            {collection.description && (
              <span className="text-sm text-[var(--gray-11)]">{collection.description}</span>
            )}
          </div>
        }
      >
        <div className="space-y-6">
          {activeTab === 'categories' && (
            <CategoriesTab collectionId={id!} categories={categories} onUpdate={loadData} />
          )}
          {activeTab === 'items' && (
            <ItemsTab collectionId={id!} items={items} categories={categories} templates={templates} onUpdate={loadData} />
          )}
          {activeTab === 'templates' && (
            <TemplatesTab collectionId={id!} templates={templates} onUpdate={loadData} />
          )}
          {activeTab === 'settings' && (
            <SettingsTab collection={collection} onUpdate={loadData} />
          )}
        </div>
      </WorkspaceLayout>
    </Page>
  );
}

// ============================================================
// Categories Tab — inline list with add/edit/reorder
// ============================================================

function CategoriesTab({ collectionId, categories, onUpdate }: { collectionId: string; categories: SrCategory[]; onUpdate: () => void }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({ name: '', description: '', icon: '' });
  const [saving, setSaving] = useState(false);

  const handleAdd = () => {
    setAdding(true);
    setEditingId(null);
    setFormData({ name: '', description: '', icon: '' });
  };

  const handleEdit = (cat: SrCategory) => {
    setAdding(false);
    setEditingId(cat.id);
    setFormData({ name: cat.name, description: cat.description || '', icon: cat.icon || '' });
  };

  const handleSave = async () => {
    if (!formData.name.trim()) { toast.error('Name is required'); return; }
    setSaving(true);
    try {
      const cleaned = { name: formData.name.trim(), description: formData.description.trim() || null, icon: formData.icon.trim() || null };
      if (editingId) {
        const res = await CategoriesService.update(editingId, cleaned);
        if (!res.success) throw new Error(res.error);
        toast.success('Category updated');
      } else {
        const res = await CategoriesService.create({ ...cleaned, collection_id: collectionId, sort_order: categories.length });
        if (!res.success) throw new Error(res.error);
        toast.success('Category created');
      }
      setAdding(false);
      setEditingId(null);
      onUpdate();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (cat: SrCategory) => {
    if (!confirm(`Delete "${cat.name}"? All items in this category will also be deleted.`)) return;
    const res = await CategoriesService.delete(cat.id);
    if (res.success) { toast.success('Category deleted'); onUpdate(); }
    else toast.error(res.error || 'Failed to delete');
  };

  const handleMove = async (cat: SrCategory, direction: 'up' | 'down') => {
    const idx = categories.findIndex(c => c.id === cat.id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= categories.length) return;
    const swap = categories[swapIdx];
    await CategoriesService.reorder([
      { id: cat.id, sort_order: swap.sort_order },
      { id: swap.id, sort_order: cat.sort_order },
    ]);
    onUpdate();
  };

  const renderForm = () => (
    <Card className="p-4 space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Input label="Name" value={formData.name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, name: e.target.value })} />
        <Input label="Description" value={formData.description} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, description: e.target.value })} />
        <Input label="Icon" value={formData.icon} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, icon: e.target.value })} placeholder="e.g. shield, zap" />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => { setAdding(false); setEditingId(null); }}>Cancel</Button>
        <Button onClick={handleSave} disabled={saving}>{editingId ? 'Update' : 'Add Category'}</Button>
      </div>
    </Card>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Categories</h3>
        {!adding && !editingId && <Button onClick={handleAdd}><PlusIcon className="w-4 h-4 mr-2" />Add Category</Button>}
      </div>

      {adding && renderForm()}

      {categories.length === 0 && !adding ? (
        <Card className="p-8 text-center text-[var(--gray-11)]">No categories yet. Add one to organize your items.</Card>
      ) : (
        <div className="space-y-2">
          {categories.map((cat, index) => (
            <React.Fragment key={cat.id}>
              {editingId === cat.id ? renderForm() : (
                <Card className="flex items-center gap-2 p-3">
                  <div className="flex flex-col gap-1">
                    <button onClick={() => handleMove(cat, 'up')} disabled={index === 0}
                      className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30 disabled:cursor-not-allowed">
                      <ChevronUpIcon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                    </button>
                    <button onClick={() => handleMove(cat, 'down')} disabled={index === categories.length - 1}
                      className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30 disabled:cursor-not-allowed">
                      <ChevronDownIcon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                    </button>
                  </div>
                  <div className="flex-1">
                    <span className="font-medium text-gray-900 dark:text-white">{cat.name}</span>
                    {cat.description && <span className="text-sm text-[var(--gray-11)] ml-2">{cat.description}</span>}
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => handleEdit(cat)} className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded">
                      <PencilIcon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                    </button>
                    <button onClick={() => handleDelete(cat)} className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/20 rounded">
                      <TrashIcon className="w-4 h-4 text-red-600 dark:text-red-400" />
                    </button>
                  </div>
                </Card>
              )}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Section Templates Tab — inline list with add/edit/reorder
// ============================================================

function TemplatesTab({ collectionId, templates, onUpdate }: { collectionId: string; templates: SrSectionTemplate[]; onUpdate: () => void }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({ heading: '', description: '', is_required: false });
  const [saving, setSaving] = useState(false);

  const handleAdd = () => { setAdding(true); setEditingId(null); setFormData({ heading: '', description: '', is_required: false }); };
  const handleEdit = (tpl: SrSectionTemplate) => { setAdding(false); setEditingId(tpl.id); setFormData({ heading: tpl.heading, description: tpl.description || '', is_required: tpl.is_required }); };

  const handleSave = async () => {
    if (!formData.heading.trim()) { toast.error('Heading is required'); return; }
    setSaving(true);
    try {
      const cleaned = { heading: formData.heading.trim(), description: formData.description.trim() || null, is_required: formData.is_required };
      if (editingId) {
        const res = await SectionTemplatesService.update(editingId, cleaned);
        if (!res.success) throw new Error(res.error);
        toast.success('Template updated');
      } else {
        const res = await SectionTemplatesService.create({ ...cleaned, collection_id: collectionId, sort_order: templates.length });
        if (!res.success) throw new Error(res.error);
        toast.success('Template created');
      }
      setAdding(false); setEditingId(null); onUpdate();
    } catch (err: any) { toast.error(err.message || 'Failed to save'); } finally { setSaving(false); }
  };

  const handleDelete = async (tpl: SrSectionTemplate) => {
    if (!confirm(`Delete template "${tpl.heading}"? Existing sections will keep their content.`)) return;
    const res = await SectionTemplatesService.delete(tpl.id);
    if (res.success) { toast.success('Template deleted'); onUpdate(); }
    else toast.error(res.error || 'Failed to delete');
  };

  const handleMove = async (tpl: SrSectionTemplate, direction: 'up' | 'down') => {
    const idx = templates.findIndex(t => t.id === tpl.id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= templates.length) return;
    const swap = templates[swapIdx];
    await SectionTemplatesService.reorder([
      { id: tpl.id, sort_order: swap.sort_order },
      { id: swap.id, sort_order: tpl.sort_order },
    ]);
    onUpdate();
  };

  const renderForm = () => (
    <Card className="p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Input label="Heading" value={formData.heading} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, heading: e.target.value })} />
        <Input label="Description (helper text)" value={formData.description} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, description: e.target.value })} />
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={formData.is_required} onChange={(e) => setFormData({ ...formData, is_required: e.target.checked })} className="rounded" />
        <span className="text-sm">Required section</span>
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => { setAdding(false); setEditingId(null); }}>Cancel</Button>
        <Button onClick={handleSave} disabled={saving}>{editingId ? 'Update' : 'Add Template'}</Button>
      </div>
    </Card>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Section Templates</h3>
          <p className="text-sm text-[var(--gray-11)]">Define section headings pre-populated when creating new items.</p>
        </div>
        {!adding && !editingId && <Button onClick={handleAdd}><PlusIcon className="w-4 h-4 mr-2" />Add Template</Button>}
      </div>

      {adding && renderForm()}

      {templates.length === 0 && !adding ? (
        <Card className="p-8 text-center text-[var(--gray-11)]">No section templates defined.</Card>
      ) : (
        <div className="space-y-2">
          {templates.map((tpl, index) => (
            <React.Fragment key={tpl.id}>
              {editingId === tpl.id ? renderForm() : (
                <Card className="flex items-center gap-2 p-3">
                  <div className="flex flex-col gap-1">
                    <button onClick={() => handleMove(tpl, 'up')} disabled={index === 0}
                      className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30 disabled:cursor-not-allowed">
                      <ChevronUpIcon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                    </button>
                    <button onClick={() => handleMove(tpl, 'down')} disabled={index === templates.length - 1}
                      className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-30 disabled:cursor-not-allowed">
                      <ChevronDownIcon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                    </button>
                  </div>
                  <div className="flex-1">
                    <span className="font-medium text-gray-900 dark:text-white">{tpl.heading}</span>
                    {tpl.is_required && <Badge color="blue" className="ml-2">Required</Badge>}
                    {tpl.description && <p className="text-sm text-[var(--gray-11)] mt-0.5">{tpl.description}</p>}
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => handleEdit(tpl)} className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded">
                      <PencilIcon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                    </button>
                    <button onClick={() => handleDelete(tpl)} className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/20 rounded">
                      <TrashIcon className="w-4 h-4 text-red-600 dark:text-red-400" />
                    </button>
                  </div>
                </Card>
              )}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Items Tab — card list with inline add, edit navigates to item detail
// ============================================================

// Section editing modes under the structured-blocks model:
//  'classic' — no blocks: the original RichTextEditor over sr_sections.content
//  'mirror'  — exactly one html block (the migration backfill state): the
//              RichTextEditor edits the block's html, and saving writes BOTH
//              the block and content so the mirror never goes stale
//  'blocks'  — typed blocks (talk cards etc.): the structured block editor
type BlockDraft = { kind: string; slug: string | null; sort_order: number; data: Record<string, any> };
type EditableSection = {
  id?: string;
  heading: string;
  content: string;
  template_id: string | null;
  sort_order: number;
  mode: 'classic' | 'mirror' | 'blocks';
  blocks: BlockDraft[];
};

function sectionMode(blocks: { kind: string }[] | undefined): EditableSection['mode'] {
  if (!blocks || blocks.length === 0) return 'classic';
  if (blocks.length === 1 && blocks[0].kind === 'html') return 'mirror';
  return 'blocks';
}

const EMPTY_TALK: () => Record<string, any> = () => ({
  title: '', speaker: { name: '' }, youtube_id: '', worth_noting: '', quote: '', topics: [],
});

function TalkBlockForm({ block, onChange }: { block: BlockDraft; onChange: (data: Record<string, any>) => void }) {
  const d = block.data;
  const set = (patch: Record<string, any>) => onChange({ ...d, ...patch });
  const setSpeaker = (patch: Record<string, any>) => set({ speaker: { ...(d.speaker || {}), ...patch } });
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Input label="Talk title" value={d.title || ''} onChange={(e: any) => set({ title: e.target.value })} />
        <Input label="YouTube ID" value={d.youtube_id || ''} onChange={(e: any) => set({ youtube_id: e.target.value })} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Input label="Speaker name" value={d.speaker?.name || ''} onChange={(e: any) => setSpeaker({ name: e.target.value })} />
        <Input label="Company / role line" value={d.speaker?.company || ''} onChange={(e: any) => setSpeaker({ company: e.target.value || undefined })} />
        <Input label="LinkedIn URL" value={d.speaker?.linkedin || ''} onChange={(e: any) => setSpeaker({ linkedin: e.target.value || undefined })} />
      </div>
      <Input label="Worth noting" value={d.worth_noting || ''} onChange={(e: any) => set({ worth_noting: e.target.value })} />
      <Input label="Quote" value={d.quote || ''} onChange={(e: any) => set({ quote: e.target.value })} />
      <div className="grid grid-cols-3 gap-2">
        <Input label="Topics (comma-separated)" value={(d.topics || []).join(', ')}
          onChange={(e: any) => set({ topics: e.target.value.split(',').map((t: string) => t.trim()).filter(Boolean) })} />
        <Input label="Accent (#hex)" value={d.accent || ''} onChange={(e: any) => set({ accent: e.target.value || undefined })} />
        <Input label="External URL (title link)" value={d.url || ''} onChange={(e: any) => set({ url: e.target.value || undefined })} />
      </div>
    </div>
  );
}

function ItemsTab({ collectionId, items, categories, templates, onUpdate }: {
  collectionId: string; items: SrItem[]; categories: SrCategory[]; templates: SrSectionTemplate[]; onUpdate: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({ title: '', subtitle: '', category_id: '', external_url: '', featured_image_url: '', status: 'draft' as string });
  const [itemSections, setItemSections] = useState<EditableSection[]>([]);
  const [saving, setSaving] = useState(false);
  const [genCover, setGenCover] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [filterCategory, setFilterCategory] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [search, setSearch] = useState('');

  const handleGenerateCover = async () => {
    if (!editingId) { toast.error('Save the item first, then generate its cover'); return; }
    setGenCover(true);
    try {
      const res = await generateCover('item', editingId);
      if (res.success) { setFormData(prev => ({ ...prev, featured_image_url: res.url })); toast.success('Cover image generated'); }
      else toast.error(res.error || 'Failed to generate cover');
    } finally { setGenCover(false); }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!editingId) { toast.error('Save the item first, then upload its image'); return; }
    setUploading(true);
    try {
      const res = await uploadCoverImage(file, 'item', editingId);
      if (res.success) { setFormData(prev => ({ ...prev, featured_image_url: res.url })); toast.success('Image uploaded'); }
      else toast.error(res.error || 'Upload failed');
    } finally { setUploading(false); }
  };

  const handleAdd = () => {
    setAdding(true);
    setEditingId(null);
    setFormData({ title: '', subtitle: '', category_id: categories[0]?.id || '', external_url: '', featured_image_url: '', status: 'draft' });
    setItemSections(templates.map((t, i) => ({ heading: t.heading, content: '', template_id: t.id, sort_order: i, mode: 'classic' as const, blocks: [] })));
  };

  const handleEdit = async (item: SrItem) => {
    setAdding(false);
    setEditingId(item.id);
    setFormData({ title: item.title, subtitle: item.subtitle || '', category_id: item.category_id, external_url: item.external_url || '', featured_image_url: item.featured_image_url || '', status: item.status });
    const secRes = await SectionsService.getByItem(item.id);
    if (secRes.success && secRes.data) {
      setItemSections(secRes.data.map(s => {
        const blocks = ((s as any).blocks || []).map((b: any) => ({ kind: b.kind, slug: b.slug, sort_order: b.sort_order, data: b.data }));
        const mode = sectionMode(blocks);
        return {
          id: s.id,
          heading: s.heading,
          // mirror mode edits the block's html (the render source of truth)
          content: mode === 'mirror' ? (blocks[0].data.html ?? '') : (s.content || ''),
          template_id: s.template_id,
          sort_order: s.sort_order,
          mode,
          blocks,
        };
      }));
    } else {
      setItemSections([]);
    }
  };

  const handleSave = async () => {
    if (!formData.title.trim()) { toast.error('Title is required'); return; }
    if (!formData.category_id) { toast.error('Category is required'); return; }
    setSaving(true);
    try {
      const cleaned = {
        title: formData.title.trim(),
        subtitle: formData.subtitle.trim() || null,
        category_id: formData.category_id,
        external_url: formData.external_url.trim() || null,
        featured_image_url: formData.featured_image_url.trim() || null,
        status: formData.status as 'draft' | 'published' | 'archived',
      };

      if (editingId) {
        const res = await ItemsService.update(editingId, cleaned);
        if (!res.success) throw new Error(res.error);
        // blocks-mode sections keep their stored content untouched (null for
        // promoted talk sections); mirror mode writes the edited html to BOTH
        // content and the block so the pair never diverges
        const secRes = await SectionsService.upsertForItem(editingId, itemSections.map(s => ({
          id: s.id, heading: s.heading, template_id: s.template_id, sort_order: s.sort_order,
          content: s.mode === 'blocks' ? null : (s.content || null),
        })));
        if (!secRes.success) throw new Error(secRes.error);
        // item-wide pre-write talk slugs (title -> slug) for the reuse rule
        const preWrite = new Map<string, string>();
        for (const s of itemSections) {
          for (const b of s.blocks) {
            if (b.kind === 'talk' && b.slug && typeof b.data.title === 'string' && !preWrite.has(b.data.title)) {
              preWrite.set(b.data.title, b.slug);
            }
          }
        }
        for (const s of itemSections) {
          if (!s.id || s.mode === 'classic') continue;
          const blocks = s.mode === 'mirror'
            ? (s.content.trim() ? [{ kind: 'html', slug: null, sort_order: 0, data: { ...s.blocks[0]?.data, html: s.content } }] : [])
            : s.blocks;
          const blkRes = await SectionsService.replaceSectionBlocks(editingId, s.id, blocks, preWrite);
          if (!blkRes.success) throw new Error(blkRes.error);
        }
        toast.success('Item updated');
      } else {
        const res = await ItemsService.create(
          { ...cleaned, collection_id: collectionId, sort_order: items.length },
          itemSections.map(s => ({ heading: s.heading, content: s.content || null, template_id: s.template_id, sort_order: s.sort_order }))
        );
        if (!res.success) throw new Error(res.error);
        toast.success('Item created');
      }
      setAdding(false);
      setEditingId(null);
      onUpdate();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item: SrItem) => {
    if (!confirm(`Delete "${item.title}" and all its sections?`)) return;
    const res = await ItemsService.delete(item.id);
    if (res.success) { toast.success('Item deleted'); onUpdate(); }
    else toast.error(res.error || 'Failed to delete');
  };

  const addSection = () => {
    setItemSections(prev => [...prev, { heading: 'New Section', content: '', template_id: null, sort_order: prev.length, mode: 'classic' as const, blocks: [] }]);
  };

  const updateSectionBlocks = (index: number, fn: (blocks: BlockDraft[]) => BlockDraft[]) => {
    setItemSections(prev => prev.map((s, i) => i === index ? { ...s, blocks: fn(s.blocks) } : s));
  };

  const filteredItems = items.filter(item => {
    if (filterCategory && item.category_id !== filterCategory) return false;
    if (filterStatus && item.status !== filterStatus) return false;
    if (search) {
      const term = search.toLowerCase();
      if (!item.title.toLowerCase().includes(term) && !item.subtitle?.toLowerCase().includes(term)) return false;
    }
    return true;
  });

  const statusColor = (s: string) => s === 'published' ? 'success' : s === 'draft' ? 'warning' : 'neutral';

  const renderForm = () => (
    <Card className="p-4 space-y-4">
      <h3 className="font-semibold text-gray-900 dark:text-white">{editingId ? 'Edit Item' : 'New Item'}</h3>
      <div className="grid grid-cols-2 gap-3">
        <Input label="Title" value={formData.title} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, title: e.target.value })} />
        <Input label="Subtitle" value={formData.subtitle} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, subtitle: e.target.value })} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Select label="Category" value={formData.category_id} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, category_id: e.target.value })}
          data={categories.map(c => ({ value: c.id, label: c.name }))} />
        <Select label="Status" value={formData.status} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, status: e.target.value })}
          data={[{ value: 'draft', label: 'Draft' }, { value: 'published', label: 'Published' }, { value: 'archived', label: 'Archived' }]} />
        <Input label="External URL" value={formData.external_url} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, external_url: e.target.value })} />
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input label="Featured Image URL" value={formData.featured_image_url} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, featured_image_url: e.target.value })} placeholder="Paste a URL, upload, or generate with AI →" />
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />
        <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading || !editingId} title={!editingId ? 'Save the item first' : 'Upload an image from your computer'}>
          {uploading ? 'Uploading…' : 'Upload'}
        </Button>
        <Button type="button" variant="outline" onClick={handleGenerateCover} disabled={genCover || !editingId} title={!editingId ? 'Save the item first' : 'Generate an AAIF-branded cover with AI'}>
          {genCover ? 'Generating…' : 'Generate with AI'}
        </Button>
      </div>
      {formData.featured_image_url && (
        <img src={formData.featured_image_url} alt="" className="rounded-lg border max-h-40 object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
      )}

      {/* Sections */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-medium text-gray-900 dark:text-white">Sections</h4>
          <Button variant="ghost" onClick={addSection}><PlusIcon className="w-4 h-4 mr-1" />Add Section</Button>
        </div>
        {itemSections.map((section, index) => (
          <div key={index} className="mb-4 border rounded-lg p-4 bg-gray-50 dark:bg-gray-800">
            <div className="flex items-center justify-between mb-2">
              <Input value={section.heading} onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setItemSections(prev => prev.map((s, i) => i === index ? { ...s, heading: e.target.value } : s));
              }} className="font-medium" placeholder="Section heading" />
              <button type="button" onClick={() => setItemSections(prev => prev.filter((_, i) => i !== index))}
                className="p-1 text-gray-400 hover:text-red-600 ml-2">
                <TrashIcon className="w-4 h-4" />
              </button>
            </div>
            {section.mode !== 'blocks' && (
              <RichTextEditor value={section.content} onChange={(val: string) => {
                setItemSections(prev => prev.map((s, i) => i === index ? { ...s, content: val } : s));
              }} />
            )}
            {section.mode === 'blocks' && (
              <div className="space-y-3">
                {section.blocks.map((block, bi) => (
                  <div key={bi} className="border rounded-lg p-3 bg-white dark:bg-gray-900">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Badge color={block.kind === 'talk' ? 'success' : 'neutral'}>{block.kind}</Badge>
                        {block.slug && <span className="text-xs text-[var(--gray-a9)] font-mono">{block.slug}</span>}
                      </div>
                      <div className="flex gap-1">
                        <button type="button" disabled={bi === 0} className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                          onClick={() => updateSectionBlocks(index, (blocks) => {
                            const next = [...blocks];[next[bi - 1], next[bi]] = [next[bi], next[bi - 1]];return next;
                          })}>↑</button>
                        <button type="button" disabled={bi === section.blocks.length - 1} className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                          onClick={() => updateSectionBlocks(index, (blocks) => {
                            const next = [...blocks];[next[bi + 1], next[bi]] = [next[bi], next[bi + 1]];return next;
                          })}>↓</button>
                        <button type="button" className="p-1 text-gray-400 hover:text-red-600"
                          onClick={() => updateSectionBlocks(index, (blocks) => blocks.filter((_, k) => k !== bi))}>
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    {block.kind === 'talk' ? (
                      <TalkBlockForm block={block} onChange={(data) =>
                        updateSectionBlocks(index, (blocks) => blocks.map((b, k) => k === bi ? { ...b, data } : b))} />
                    ) : (
                      <textarea
                        className="w-full h-40 font-mono text-xs border rounded p-2 bg-gray-50 dark:bg-gray-800"
                        value={block.data.html || ''}
                        onChange={(e) => updateSectionBlocks(index, (blocks) =>
                          blocks.map((b, k) => k === bi ? { ...b, data: { ...b.data, html: e.target.value } } : b))}
                      />
                    )}
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => updateSectionBlocks(index, (blocks) =>
                    [...blocks, { kind: 'talk', slug: null, sort_order: blocks.length, data: EMPTY_TALK() }])}>
                    <PlusIcon className="w-4 h-4 mr-1" />Talk block
                  </Button>
                  <Button variant="ghost" onClick={() => updateSectionBlocks(index, (blocks) =>
                    [...blocks, { kind: 'html', slug: null, sort_order: blocks.length, data: { html: '' } }])}>
                    <PlusIcon className="w-4 h-4 mr-1" />HTML block
                  </Button>
                </div>
              </div>
            )}
            {section.mode === 'mirror' && section.id && (
              <button type="button" className="mt-2 text-xs text-[var(--gray-a9)] hover:text-[var(--gray-11)] underline"
                onClick={() => setItemSections(prev => prev.map((s, i) => i === index ? { ...s, mode: 'blocks' as const } : s))}>
                Convert to structured blocks…
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={() => { setAdding(false); setEditingId(null); }}>Cancel</Button>
        <Button onClick={handleSave} disabled={saving}>{editingId ? 'Save Changes' : 'Create Item'}</Button>
      </div>
    </Card>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Items</h3>
        {!adding && !editingId && <Button onClick={handleAdd}><PlusIcon className="w-4 h-4 mr-2" />Add Item</Button>}
      </div>

      {!adding && !editingId && (
        <div className="flex items-center gap-3 mb-4">
          <Input placeholder="Search items..." value={search} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)} className="flex-1" />
          <Select value={filterCategory} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setFilterCategory(e.target.value)}
            data={[{ value: '', label: 'All Categories' }, ...categories.map(c => ({ value: c.id, label: c.name }))]} />
          <Select value={filterStatus} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setFilterStatus(e.target.value)}
            data={[{ value: '', label: 'All Statuses' }, { value: 'draft', label: 'Draft' }, { value: 'published', label: 'Published' }, { value: 'archived', label: 'Archived' }]} />
        </div>
      )}

      {(adding && !editingId) && renderForm()}

      {filteredItems.length === 0 && !adding ? (
        <Card className="p-8 text-center text-[var(--gray-11)]">No items found.</Card>
      ) : (
        <div className="space-y-2">
          {filteredItems.map((item) => (
            <React.Fragment key={item.id}>
              {editingId === item.id ? renderForm() : (
                <Card className="flex items-center gap-3 p-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900 dark:text-white truncate">{item.title}</span>
                      <Badge color={statusColor(item.status)}>{item.status}</Badge>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {item.subtitle && <span className="text-sm text-[var(--gray-11)] truncate">{item.subtitle}</span>}
                      {item.category && <span className="text-xs text-[var(--gray-a9)]">in {item.category.name}</span>}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => handleEdit(item)} className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded">
                      <PencilIcon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                    </button>
                    <button onClick={() => handleDelete(item)} className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/20 rounded">
                      <TrashIcon className="w-4 h-4 text-red-600 dark:text-red-400" />
                    </button>
                  </div>
                </Card>
              )}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Settings Tab — inline edit/display toggle
// ============================================================

function SettingsTab({ collection, onUpdate }: { collection: SrCollection; onUpdate: () => void }) {
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [genCover, setGenCover] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleGenerateCover = async () => {
    setGenCover(true);
    try {
      const res = await generateCover('collection', collection.id);
      if (res.success) { setFormData(prev => ({ ...prev, cover_image_url: res.url })); toast.success('Cover image generated'); }
      else toast.error(res.error || 'Failed to generate cover');
    } finally { setGenCover(false); }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const res = await uploadCoverImage(file, 'collection', collection.id);
      if (res.success) { setFormData(prev => ({ ...prev, cover_image_url: res.url })); toast.success('Image uploaded'); }
      else toast.error(res.error || 'Upload failed');
    } finally { setUploading(false); }
  };
  const [formData, setFormData] = useState({
    name: collection.name,
    description: collection.description || '',
    status: collection.status,
    access: collection.access,
    cover_image_url: collection.cover_image_url || '',
    meta_title: collection.meta_title || '',
    meta_description: collection.meta_description || '',
  });

  useEffect(() => {
    setFormData({
      name: collection.name,
      description: collection.description || '',
      status: collection.status,
      access: collection.access,
      cover_image_url: collection.cover_image_url || '',
      meta_title: collection.meta_title || '',
      meta_description: collection.meta_description || '',
    });
  }, [collection]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const cleaned = {
        name: formData.name.trim(),
        description: formData.description.trim() || null,
        status: formData.status as 'draft' | 'published' | 'archived',
        access: formData.access as 'public' | 'authenticated' | 'inherit',
        cover_image_url: formData.cover_image_url.trim() || null,
        meta_title: formData.meta_title.trim() || null,
        meta_description: formData.meta_description.trim() || null,
      };
      const res = await CollectionsService.update(collection.id, cleaned);
      if (!res.success) throw new Error(res.error);
      toast.success('Collection updated');
      setIsEditing(false);
      onUpdate();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const accessLabel = (a: string) => a === 'public' ? 'Public' : a === 'metered' ? 'Metered (SEO gate)' : a === 'authenticated' ? 'Login Required' : 'Module Default';

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Collection Settings</h3>
        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <Button variant="outlined" onClick={() => setIsEditing(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving}>Save Changes</Button>
            </>
          ) : (
            <Button onClick={() => setIsEditing(true)}>
              <PencilIcon className="w-4 h-4 mr-2" />Edit
            </Button>
          )}
        </div>
      </div>

      <Card>
        <div className="p-6">
          {isEditing ? (
            <div className="space-y-4">
              <Input label="Name" value={formData.name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, name: e.target.value })} />
              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <textarea value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700" rows={3} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Select label="Status" value={formData.status} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, status: e.target.value })}
                  data={[{ value: 'draft', label: 'Draft' }, { value: 'published', label: 'Published' }, { value: 'archived', label: 'Archived' }]} />
                <Select label="Access" value={formData.access} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, access: e.target.value })}
                  data={[{ value: 'inherit', label: 'Module Default' }, { value: 'public', label: 'Public' }, { value: 'metered', label: 'Metered (SEO gate)' }, { value: 'authenticated', label: 'Login Required' }]} />
              </div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Input label="Cover Image URL" value={formData.cover_image_url} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, cover_image_url: e.target.value })} placeholder="Paste a URL, upload, or generate with AI →" />
                </div>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />
                <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading} title="Upload an image from your computer">
                  {uploading ? 'Uploading…' : 'Upload'}
                </Button>
                <Button type="button" variant="outline" onClick={handleGenerateCover} disabled={genCover} title="Generate an AAIF-branded cover with AI">
                  {genCover ? 'Generating…' : 'Generate with AI'}
                </Button>
              </div>
              {formData.cover_image_url && (
                <img src={formData.cover_image_url} alt="" className="rounded-lg border max-h-40 object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              )}
              <Input label="Meta Title" value={formData.meta_title} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, meta_title: e.target.value })} />
              <Input label="Meta Description" value={formData.meta_description} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, meta_description: e.target.value })} />
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Status</label>
                  <p className="text-gray-900 dark:text-white capitalize">{collection.status}</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Access</label>
                  <p className="text-gray-900 dark:text-white">{accessLabel(collection.access)}</p>
                </div>
              </div>
              {collection.description && (
                <div className="pt-3 border-t dark:border-gray-700">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                  <p className="text-gray-900 dark:text-white">{collection.description}</p>
                </div>
              )}
              {(collection.meta_title || collection.meta_description) && (
                <div className="pt-3 border-t dark:border-gray-700">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SEO</label>
                  {collection.meta_title && <p className="text-gray-900 dark:text-white">{collection.meta_title}</p>}
                  {collection.meta_description && <p className="text-[var(--gray-11)] mt-1">{collection.meta_description}</p>}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
