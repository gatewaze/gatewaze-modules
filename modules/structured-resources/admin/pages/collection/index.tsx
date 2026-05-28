import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeftIcon,
  PlusIcon,
  PencilIcon,
  TrashIcon,
  ChevronUpIcon,
  ChevronDownIcon,
} from '@heroicons/react/24/outline';
import { Button, Card, Badge, Input, Select, Tabs, Modal, ConfirmModal } from '@/components/ui';
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
    navigate(`/structured-resources/collections/${id}/${newTab}`);
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

  const tabs = [
    { id: 'categories' as TabType, label: `Categories (${categories.length})` },
    { id: 'items' as TabType, label: `Items (${items.length})` },
    { id: 'templates' as TabType, label: `Section Templates (${templates.length})` },
    { id: 'settings' as TabType, label: 'Settings' },
  ];

  if (loading) {
    return (
      <Page title="Loading...">
        <div className="flex justify-center items-center py-12">
          <LoadingSpinner size="large" />
        </div>
      </Page>
    );
  }

  if (!collection) {
    return (
      <Page title="Not Found">
        <Card className="p-12 text-center">
          <p className="text-[var(--gray-11)] mb-4">Collection not found</p>
          <Button onClick={() => navigate('/structured-resources/collections')}>Back to Collections</Button>
        </Card>
      </Page>
    );
  }

  const statusColor = (s: string) => s === 'published' ? 'success' : s === 'draft' ? 'warning' : 'neutral';

  return (
    <Page>
      {/* Hero */}
      <div className="relative h-36 md:h-44 overflow-hidden bg-gray-900 -mx-(--margin-x) -mt-(--margin-x)">
        {collection.cover_image_url ? (
          <img src={collection.cover_image_url} alt="" className="absolute inset-0 w-full h-full object-cover blur-[10px] scale-105" />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-primary-600 to-primary-800 dark:from-primary-800 dark:to-primary-950" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-black/20" />

        <div className="absolute top-6 z-10" style={{ left: 'calc(var(--margin-x) + 1.5rem)' }}>
          <button
            onClick={() => navigate('/structured-resources/collections')}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-white/90 backdrop-blur-md border border-white/40 text-gray-900 shadow-sm hover:bg-white transition-colors"
          >
            <ArrowLeftIcon className="size-4" />
            Back
          </button>
        </div>

        <div className="absolute bottom-0 left-0 right-0" style={{ padding: '0 calc(var(--margin-x) + 1.5rem) 1.5rem' }}>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl md:text-3xl font-bold text-white drop-shadow-lg">{collection.name}</h1>
            <Badge color={statusColor(collection.status)} className="text-sm">{collection.status}</Badge>
          </div>
          {collection.description && (
            <p className="text-sm text-white/80">{collection.description}</p>
          )}
        </div>
      </div>

      <div className="-mx-(--margin-x)">
        <Tabs fullWidth value={activeTab} onChange={(t) => navigateToTab(t as TabType)} tabs={tabs} />
      </div>

      <div className="p-6 space-y-6">
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

function ItemsTab({ collectionId, items, categories, templates, onUpdate }: {
  collectionId: string; items: SrItem[]; categories: SrCategory[]; templates: SrSectionTemplate[]; onUpdate: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({ title: '', subtitle: '', category_id: '', external_url: '', featured_image_url: '', status: 'draft' as string });
  const [itemSections, setItemSections] = useState<{ id?: string; heading: string; content: string; template_id: string | null; sort_order: number }[]>([]);
  const [saving, setSaving] = useState(false);
  const [filterCategory, setFilterCategory] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [search, setSearch] = useState('');

  const handleAdd = () => {
    setAdding(true);
    setEditingId(null);
    setFormData({ title: '', subtitle: '', category_id: categories[0]?.id || '', external_url: '', featured_image_url: '', status: 'draft' });
    setItemSections(templates.map((t, i) => ({ heading: t.heading, content: '', template_id: t.id, sort_order: i })));
  };

  const handleEdit = async (item: SrItem) => {
    setAdding(false);
    setEditingId(item.id);
    setFormData({ title: item.title, subtitle: item.subtitle || '', category_id: item.category_id, external_url: item.external_url || '', featured_image_url: item.featured_image_url || '', status: item.status });
    const secRes = await SectionsService.getByItem(item.id);
    if (secRes.success && secRes.data) {
      setItemSections(secRes.data.map(s => ({ id: s.id, heading: s.heading, content: s.content || '', template_id: s.template_id, sort_order: s.sort_order })));
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
        const secRes = await SectionsService.upsertForItem(editingId, itemSections.map(s => ({ ...s, content: s.content || null })));
        if (!secRes.success) throw new Error(secRes.error);
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
    setItemSections(prev => [...prev, { heading: 'New Section', content: '', template_id: null, sort_order: prev.length }]);
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
      <Input label="Featured Image URL" value={formData.featured_image_url} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, featured_image_url: e.target.value })} />

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
            <RichTextEditor value={section.content} onChange={(val: string) => {
              setItemSections(prev => prev.map((s, i) => i === index ? { ...s, content: val } : s));
            }} />
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

  const accessLabel = (a: string) => a === 'public' ? 'Public' : a === 'authenticated' ? 'Login Required' : 'Module Default';

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
                  data={[{ value: 'inherit', label: 'Module Default' }, { value: 'public', label: 'Public' }, { value: 'authenticated', label: 'Login Required' }]} />
              </div>
              <Input label="Cover Image URL" value={formData.cover_image_url} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, cover_image_url: e.target.value })} />
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
