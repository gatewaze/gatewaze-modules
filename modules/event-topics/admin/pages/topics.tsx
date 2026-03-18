import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  PlusIcon,
  PencilIcon,
  TrashIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  HashtagIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { useForm } from 'react-hook-form';
import { yupResolver } from '@hookform/resolvers/yup';
import * as Yup from 'yup';
import { toast } from 'sonner';

import { Button, Card, Badge, Modal, ConfirmModal, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { Input, Checkbox } from '@/components/ui/Form';
import { Page } from '@/components/shared/Page';
import { RowActions } from '@/components/shared/table/RowActions';
import { supabase } from '@/lib/supabase';

// ─── Types ───────────────────────────────────────────────────────────

interface TopicCategory {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  display_order: number;
  created_at: string;
}

interface Topic {
  id: string;
  name: string;
  slug: string;
  display_order: number;
  created_at: string;
}

interface Membership {
  id: string;
  topic_id: string;
  category_id: string;
}

interface TreeNode extends TopicCategory {
  children: TreeNode[];
  topicCount: number;
}

// ─── Validation ──────────────────────────────────────────────────────

const categorySchema = Yup.object().shape({
  name: Yup.string().required('Name is required'),
  slug: Yup.string()
    .required('Slug is required')
    .matches(/^[a-z0-9-]+$/, 'Only lowercase letters, numbers, and hyphens'),
  parent_id: Yup.string().nullable(),
  display_order: Yup.number().integer().min(0).default(0),
});

const topicSchema = Yup.object().shape({
  name: Yup.string().required('Name is required'),
  slug: Yup.string()
    .required('Slug is required')
    .matches(/^[a-z0-9-]+$/, 'Only lowercase letters, numbers, and hyphens'),
  display_order: Yup.number().integer().min(0).default(0),
  category_ids: Yup.array().of(Yup.string()).min(1, 'Select at least one category'),
});

// ─── Helpers ─────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[/&]/g, ' ')
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildTree(categories: TopicCategory[], memberships: Membership[]): TreeNode[] {
  const countByCategory = new Map<string, number>();
  for (const m of memberships) {
    countByCategory.set(m.category_id, (countByCategory.get(m.category_id) || 0) + 1);
  }

  const nodeMap = new Map<string, TreeNode>();
  for (const cat of categories) {
    nodeMap.set(cat.id, {
      ...cat,
      children: [],
      topicCount: countByCategory.get(cat.id) || 0,
    });
  }

  const roots: TreeNode[] = [];
  for (const node of nodeMap.values()) {
    if (node.parent_id && nodeMap.has(node.parent_id)) {
      nodeMap.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name));
    for (const n of nodes) sortNodes(n.children);
  };
  sortNodes(roots);
  return roots;
}

function getDescendantIds(node: TreeNode): string[] {
  const ids = [node.id];
  for (const child of node.children) {
    ids.push(...getDescendantIds(child));
  }
  return ids;
}

function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      result.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return result;
}

// ─── Main Component ──────────────────────────────────────────────────

export default function TopicsAdmin() {
  const [categories, setCategories] = useState<TopicCategory[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);

  // UI state
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  // Modals
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<TopicCategory | null>(null);
  const [topicModalOpen, setTopicModalOpen] = useState(false);
  const [editingTopic, setEditingTopic] = useState<Topic | null>(null);
  const [editingTopicCategoryIds, setEditingTopicCategoryIds] = useState<string[]>([]);
  const [deletingCategory, setDeletingCategory] = useState<TopicCategory | null>(null);
  const [deletingTopic, setDeletingTopic] = useState<Topic | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Forms
  const categoryForm = useForm({
    resolver: yupResolver(categorySchema) as any,
    defaultValues: { name: '', slug: '', parent_id: null as string | null, display_order: 0 },
  });

  const topicForm = useForm({
    resolver: yupResolver(topicSchema) as any,
    defaultValues: { name: '', slug: '', display_order: 0, category_ids: [] as string[] },
  });

  // ─── Data Loading ────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [catRes, topicRes, memRes] = await Promise.all([
        supabase.from('events_topic_categories').select('*').order('display_order'),
        supabase.from('events_topics').select('*').order('display_order'),
        supabase.from('events_topic_category_memberships').select('*'),
      ]);
      if (catRes.error) throw catRes.error;
      if (topicRes.error) throw topicRes.error;
      if (memRes.error) throw memRes.error;

      setCategories(catRes.data || []);
      setTopics(topicRes.data || []);
      setMemberships(memRes.data || []);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ─── Derived Data ────────────────────────────────────────────────

  const tree = useMemo(() => buildTree(categories, memberships), [categories, memberships]);

  const allCategories = useMemo(() => flattenTree(tree), [tree]);

  // Category name lookup
  const categoryNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories) m.set(c.id, c.name);
    return m;
  }, [categories]);

  // Filtered topics for the selected category
  const visibleTopics = useMemo(() => {
    let filtered = topics;

    // Filter by selected category (include descendants)
    if (selectedCategoryId) {
      const selectedNode = allCategories.find((c) => c.id === selectedCategoryId);
      if (selectedNode) {
        const relevantIds = new Set(getDescendantIds(selectedNode));
        const topicIdsInCategory = new Set(
          memberships.filter((m) => relevantIds.has(m.category_id)).map((m) => m.topic_id)
        );
        filtered = filtered.filter((t) => topicIdsInCategory.has(t.id));
      }
    }

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter(
        (t) => t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q)
      );
    }

    return filtered.sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name));
  }, [topics, selectedCategoryId, search, memberships, allCategories]);

  // Topic → categories lookup
  const topicCategoriesMap = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const mem of memberships) {
      if (!m.has(mem.topic_id)) m.set(mem.topic_id, []);
      m.get(mem.topic_id)!.push(mem.category_id);
    }
    return m;
  }, [memberships]);

  const totalTopicCount = topics.length;

  // ─── Category CRUD ───────────────────────────────────────────────

  const openCategoryModal = (category?: TopicCategory) => {
    if (category) {
      setEditingCategory(category);
      categoryForm.reset({
        name: category.name,
        slug: category.slug,
        parent_id: category.parent_id,
        display_order: category.display_order,
      });
    } else {
      setEditingCategory(null);
      categoryForm.reset({
        name: '',
        slug: '',
        parent_id: selectedCategoryId,
        display_order: 0,
      });
    }
    setCategoryModalOpen(true);
  };

  const handleCategorySubmit = async (data: any) => {
    setSubmitting(true);
    try {
      const payload = {
        name: data.name,
        slug: data.slug,
        parent_id: data.parent_id || null,
        display_order: data.display_order || 0,
      };

      if (editingCategory) {
        const { error } = await supabase
          .from('events_topic_categories')
          .update(payload)
          .eq('id', editingCategory.id);
        if (error) throw error;
        toast.success('Category updated');
      } else {
        const { error } = await supabase.from('events_topic_categories').insert(payload);
        if (error) throw error;
        toast.success('Category created');
      }
      setCategoryModalOpen(false);
      setEditingCategory(null);
      loadAll();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save category');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteCategory = async () => {
    if (!deletingCategory) return;
    try {
      const { error } = await supabase
        .from('events_topic_categories')
        .delete()
        .eq('id', deletingCategory.id);
      if (error) throw error;
      toast.success('Category deleted');
      if (selectedCategoryId === deletingCategory.id) setSelectedCategoryId(null);
      setDeletingCategory(null);
      loadAll();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to delete category');
    }
  };

  // ─── Topic CRUD ──────────────────────────────────────────────────

  const openTopicModal = (topic?: Topic) => {
    if (topic) {
      setEditingTopic(topic);
      const catIds = topicCategoriesMap.get(topic.id) || [];
      setEditingTopicCategoryIds(catIds);
      topicForm.reset({
        name: topic.name,
        slug: topic.slug,
        display_order: topic.display_order,
        category_ids: catIds,
      });
    } else {
      setEditingTopic(null);
      const defaultCatIds = selectedCategoryId ? [selectedCategoryId] : [];
      setEditingTopicCategoryIds(defaultCatIds);
      topicForm.reset({
        name: '',
        slug: '',
        display_order: 0,
        category_ids: defaultCatIds,
      });
    }
    setTopicModalOpen(true);
  };

  const handleTopicSubmit = async (data: any) => {
    setSubmitting(true);
    try {
      const categoryIds: string[] = editingTopicCategoryIds;
      if (categoryIds.length === 0) {
        toast.error('Select at least one category');
        setSubmitting(false);
        return;
      }

      if (editingTopic) {
        // Update topic
        const { error } = await supabase
          .from('events_topics')
          .update({ name: data.name, slug: data.slug, display_order: data.display_order || 0 })
          .eq('id', editingTopic.id);
        if (error) throw error;

        // Sync memberships: delete old, insert new
        await supabase.from('events_topic_category_memberships').delete().eq('topic_id', editingTopic.id);
        const { error: memError } = await supabase.from('events_topic_category_memberships').insert(
          categoryIds.map((cid) => ({ topic_id: editingTopic.id, category_id: cid }))
        );
        if (memError) throw memError;
        toast.success('Topic updated');
      } else {
        // Create topic
        const { data: newTopic, error } = await supabase
          .from('events_topics')
          .insert({ name: data.name, slug: data.slug, display_order: data.display_order || 0 })
          .select('id')
          .single();
        if (error) throw error;

        // Create memberships
        const { error: memError } = await supabase.from('events_topic_category_memberships').insert(
          categoryIds.map((cid) => ({ topic_id: newTopic.id, category_id: cid }))
        );
        if (memError) throw memError;
        toast.success('Topic created');
      }
      setTopicModalOpen(false);
      setEditingTopic(null);
      loadAll();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save topic');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteTopic = async () => {
    if (!deletingTopic) return;
    try {
      const { error } = await supabase.from('events_topics').delete().eq('id', deletingTopic.id);
      if (error) throw error;
      toast.success('Topic deleted');
      setDeletingTopic(null);
      loadAll();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to delete topic');
    }
  };

  // ─── Tree Interaction ────────────────────────────────────────────

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ─── Auto-slug on name change ────────────────────────────────────

  const handleCategoryNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    categoryForm.setValue('name', e.target.value);
    if (!editingCategory) categoryForm.setValue('slug', slugify(e.target.value));
  };

  const handleTopicNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    topicForm.setValue('name', e.target.value);
    if (!editingTopic) topicForm.setValue('slug', slugify(e.target.value));
  };

  const toggleTopicCategory = (catId: string) => {
    setEditingTopicCategoryIds((prev) =>
      prev.includes(catId) ? prev.filter((id) => id !== catId) : [...prev, catId]
    );
  };

  // ─── Render ──────────────────────────────────────────────────────

  if (loading) {
    return (
      <Page title="Topics">
        <div className="flex justify-center items-center py-32">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
        </div>
      </Page>
    );
  }

  const selectedCategoryName = selectedCategoryId
    ? categoryNameMap.get(selectedCategoryId) || 'Unknown'
    : 'All Topics';

  return (
    <Page title="Topics">
      <div className="p-6">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
            Topic Taxonomy
          </h1>
          <p className="text-[var(--gray-11)] mt-1 text-sm">
            Manage topic categories and topics assigned to events.
            {' '}<span className="text-[var(--gray-a8)]">{categories.length} categories, {totalTopicCount} topics</span>
          </p>
        </div>

        {/* Two-panel layout */}
        <div className="flex gap-6 items-start">
          {/* Left: Category Tree */}
          <Card className="w-72 shrink-0 overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--gray-a5)] flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--gray-a8)]">
                Categories
              </span>
              <Button
                variant="flat"
                size="sm"
                isIcon
                onClick={() => openCategoryModal()}
                className="text-primary-600 hover:bg-primary-50 dark:hover:bg-primary-900/20"
              >
                <PlusIcon className="size-4" />
              </Button>
            </div>

            <div className="p-2 max-h-[calc(100vh-280px)] overflow-y-auto">
              {/* All Topics */}
              <Button
                variant={selectedCategoryId === null ? 'soft' : 'ghost'}
                onClick={() => setSelectedCategoryId(null)}
                style={{ width: '100%', justifyContent: 'flex-start' }}
              >
                <HashtagIcon className="size-4 shrink-0 opacity-50" />
                <span className="flex-1 text-left truncate">All Topics</span>
                <span className="text-xs tabular-nums opacity-60">{totalTopicCount}</span>
              </Button>

              {/* Tree nodes */}
              <div className="mt-1">
                {tree.map((node) => (
                  <CategoryTreeNode
                    key={node.id}
                    node={node}
                    depth={0}
                    selectedId={selectedCategoryId}
                    expandedIds={expandedIds}
                    onSelect={setSelectedCategoryId}
                    onToggleExpand={toggleExpand}
                    onEdit={openCategoryModal}
                    onDelete={setDeletingCategory}
                  />
                ))}
              </div>
            </div>
          </Card>

          {/* Right: Topics List */}
          <div className="flex-1 min-w-0">
            {/* Toolbar */}
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-medium text-[var(--gray-12)] truncate">
                  {selectedCategoryName}
                </h2>
              </div>

              {/* Search */}
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-gray-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search topics..."
                  className="pl-9 pr-8 py-2 w-56 text-sm rounded-lg border border-[var(--gray-a5)] bg-white text-[var(--gray-12)] placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500 transition-colors"
                />
                {search && (
                  <Button
                    isIcon
                    variant="ghost"
                    onClick={() => setSearch('')}
                    style={{ position: 'absolute', right: '0.625rem', top: '50%', transform: 'translateY(-50%)' }}
                  >
                    <XMarkIcon className="size-4" />
                  </Button>
                )}
              </div>

              <Button onClick={() => openTopicModal()} color="primary" className="gap-1.5 shrink-0">
                <PlusIcon className="size-4" />
                Add Topic
              </Button>
            </div>

            {/* Topics Table */}
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <Tr>
                      <Th>Topic</Th>
                      <Th>Slug</Th>
                      <Th>Categories</Th>
                      <Th />
                    </Tr>
                  </THead>
                  <TBody>
                    {visibleTopics.map((topic) => {
                      const catIds = topicCategoriesMap.get(topic.id) || [];
                      return (
                        <Tr key={topic.id}>
                          <Td>
                            <span style={{ color: 'var(--gray-12)', fontWeight: 500 }}>
                              {topic.name}
                            </span>
                          </Td>
                          <Td>
                            <span className="text-xs font-mono" style={{ color: 'var(--gray-a8)', background: 'var(--gray-a3)', padding: '2px 6px', borderRadius: '4px' }}>
                              {topic.slug}
                            </span>
                          </Td>
                          <Td>
                            <div className="flex flex-wrap gap-1">
                              {catIds.map((cid) => (
                                <Badge key={cid} color="info">
                                  {categoryNameMap.get(cid) || '?'}
                                </Badge>
                              ))}
                            </div>
                          </Td>
                          <Td>
                            <RowActions actions={[
                              { label: "Edit", icon: <PencilIcon className="size-4" />, onClick: () => openTopicModal(topic) },
                              { label: "Delete", icon: <TrashIcon className="size-4" />, onClick: () => setDeletingTopic(topic), color: "red" },
                            ]} />
                          </Td>
                        </Tr>
                      );
                    })}
                  </TBody>
                </Table>

                {visibleTopics.length === 0 && (
                  <div className="text-center py-16">
                    <HashtagIcon className="mx-auto size-10 text-gray-300 dark:text-gray-600" />
                    <p className="mt-2 text-sm text-[var(--gray-11)]">
                      {search ? 'No topics match your search' : 'No topics in this category'}
                    </p>
                    {!search && (
                      <Button
                        onClick={() => openTopicModal()}
                        color="primary"
                        variant="soft"
                        size="sm"
                        className="mt-3 gap-1.5"
                      >
                        <PlusIcon className="size-4" />
                        Add Topic
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </Card>

            {visibleTopics.length > 0 && (
              <p className="text-xs text-[var(--gray-a8)] mt-2 px-1">
                Showing {visibleTopics.length} of {totalTopicCount} topics
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ─── Category Modal ────────────────────────────────────────── */}
      <Modal
        isOpen={categoryModalOpen}
        onClose={() => { setCategoryModalOpen(false); setEditingCategory(null); }}
        title={editingCategory ? 'Edit Category' : 'Add Category'}
        footer={
          <div className="flex justify-end gap-3">
            <Button
              variant="outlined"
              onClick={() => { setCategoryModalOpen(false); setEditingCategory(null); }}
            >
              Cancel
            </Button>
            <Button
              color="primary"
              disabled={submitting}
              onClick={categoryForm.handleSubmit(handleCategorySubmit)}
            >
              {editingCategory ? 'Update' : 'Create'}
            </Button>
          </div>
        }
      >
        <form onSubmit={(e) => e.preventDefault()} className="space-y-4">
          <Input
            label="Category Name"
            placeholder="e.g., Frontend Frameworks"
            {...categoryForm.register('name')}
            onChange={handleCategoryNameChange}
            error={categoryForm.formState.errors.name?.message}
          />
          <Input
            label="Slug"
            placeholder="e.g., frontend-frameworks"
            {...categoryForm.register('slug')}
            error={categoryForm.formState.errors.slug?.message}
            description="Unique identifier. Only lowercase letters, numbers, and hyphens."
          />

          <div>
            <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">
              Parent Category
            </label>
            <select
              {...categoryForm.register('parent_id')}
              className="w-full px-3 py-2 text-sm border border-[var(--gray-a5)] rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">None (top-level)</option>
              {allCategories
                .filter((c) => c.id !== editingCategory?.id)
                .map((c) => {
                  // Show breadcrumb path
                  const parts: string[] = [c.name];
                  let current = c;
                  while (current.parent_id) {
                    const parent = categories.find((p) => p.id === current.parent_id);
                    if (parent) { parts.unshift(parent.name); current = parent as any; }
                    else break;
                  }
                  return (
                    <option key={c.id} value={c.id}>
                      {parts.join(' > ')}
                    </option>
                  );
                })}
            </select>
          </div>

          <Input
            label="Display Order"
            type="number"
            placeholder="0"
            {...categoryForm.register('display_order', { valueAsNumber: true })}
            error={categoryForm.formState.errors.display_order?.message}
          />
        </form>
      </Modal>

      {/* ─── Topic Modal ───────────────────────────────────────────── */}
      <Modal
        isOpen={topicModalOpen}
        onClose={() => { setTopicModalOpen(false); setEditingTopic(null); }}
        title={editingTopic ? 'Edit Topic' : 'Add Topic'}
        size="lg"
        footer={
          <div className="flex justify-end gap-3">
            <Button
              variant="outlined"
              onClick={() => { setTopicModalOpen(false); setEditingTopic(null); }}
            >
              Cancel
            </Button>
            <Button
              color="primary"
              disabled={submitting || editingTopicCategoryIds.length === 0}
              onClick={topicForm.handleSubmit(handleTopicSubmit)}
            >
              {editingTopic ? 'Update' : 'Create'}
            </Button>
          </div>
        }
      >
        <form onSubmit={(e) => e.preventDefault()} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Topic Name"
              placeholder="e.g., React"
              {...topicForm.register('name')}
              onChange={handleTopicNameChange}
              error={topicForm.formState.errors.name?.message}
            />
            <Input
              label="Slug"
              placeholder="e.g., react"
              {...topicForm.register('slug')}
              error={topicForm.formState.errors.slug?.message}
            />
          </div>

          <Input
            label="Display Order"
            type="number"
            placeholder="0"
            {...topicForm.register('display_order', { valueAsNumber: true })}
            error={topicForm.formState.errors.display_order?.message}
            className="w-32"
          />

          <div>
            <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">
              Categories
              {editingTopicCategoryIds.length === 0 && (
                <span className="text-red-500 ml-2 font-normal text-xs">Select at least one</span>
              )}
            </label>
            <div className="border border-[var(--gray-a5)] rounded-lg max-h-64 overflow-y-auto">
              {tree.map((rootNode) => (
                <CategoryCheckboxTree
                  key={rootNode.id}
                  node={rootNode}
                  depth={0}
                  selectedIds={editingTopicCategoryIds}
                  onToggle={toggleTopicCategory}
                />
              ))}
            </div>
          </div>
        </form>
      </Modal>

      {/* ─── Delete Confirmations ──────────────────────────────────── */}
      <ConfirmModal
        isOpen={!!deletingCategory}
        onClose={() => setDeletingCategory(null)}
        onConfirm={handleDeleteCategory}
        title="Delete Category"
        message={`Delete "${deletingCategory?.name}"? All subcategories will also be removed. Topics will remain but lose this category membership.`}
        confirmText="Delete"
        cancelText="Cancel"
      />

      <ConfirmModal
        isOpen={!!deletingTopic}
        onClose={() => setDeletingTopic(null)}
        onConfirm={handleDeleteTopic}
        title="Delete Topic"
        message={`Delete "${deletingTopic?.name}"? Events using this topic will keep the name in their text array but it won't appear in the taxonomy.`}
        confirmText="Delete"
        cancelText="Cancel"
      />
    </Page>
  );
}

// ─── Category Tree Node (sidebar) ────────────────────────────────────

function CategoryTreeNode({
  node,
  depth,
  selectedId,
  expandedIds,
  onSelect,
  onToggleExpand,
  onEdit,
  onDelete,
}: {
  node: TreeNode;
  depth: number;
  selectedId: string | null;
  expandedIds: Set<string>;
  onSelect: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onEdit: (cat: TopicCategory) => void;
  onDelete: (cat: TopicCategory) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedIds.has(node.id);
  const isSelected = selectedId === node.id;

  // Accumulate topic count including descendants
  const totalCount = useMemo(() => {
    const sum = (n: TreeNode): number =>
      n.topicCount + n.children.reduce((acc, child) => acc + sum(child), 0);
    return sum(node);
  }, [node]);

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-lg transition-colors ${
          isSelected
            ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
            : 'text-[var(--gray-11)] hover:bg-[var(--gray-a3)]'
        }`}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        {/* Expand/collapse toggle */}
        <Button
          isIcon
          variant="ghost"
          onClick={(e) => { e.stopPropagation(); if (hasChildren) onToggleExpand(node.id); }}
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
        >
          <ChevronRightIcon
            className={`size-3 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
          />
        </Button>

        {/* Icon */}
        {isExpanded && hasChildren ? (
          <FolderOpenIcon className="size-4 shrink-0 opacity-40" />
        ) : (
          <FolderIcon className="size-4 shrink-0 opacity-40" />
        )}

        {/* Label */}
        <Button
          variant="ghost"
          onClick={() => onSelect(node.id)}
          style={{ flex: 1, justifyContent: 'flex-start', textAlign: 'left' }}
          title={node.name}
        >
          <span className={isSelected ? 'font-medium' : ''}>{node.name}</span>
        </Button>

        {/* Count */}
        <span className="text-[10px] tabular-nums opacity-40 mr-1">{totalCount}</span>

        {/* Actions (visible on hover) */}
        <div className="hidden group-hover:flex items-center gap-0.5 mr-1">
          <Button
            isIcon
            variant="ghost"
            onClick={(e) => { e.stopPropagation(); onEdit(node); }}
          >
            <PencilIcon className="size-3" />
          </Button>
          <Button
            isIcon
            variant="ghost"
            color="red"
            onClick={(e) => { e.stopPropagation(); onDelete(node); }}
          >
            <TrashIcon className="size-3" />
          </Button>
        </div>
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <div>
          {node.children.map((child) => (
            <CategoryTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              expandedIds={expandedIds}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Category Checkbox Tree (for topic modal) ────────────────────────

function CategoryCheckboxTree({
  node,
  depth,
  selectedIds,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  selectedIds: string[];
  onToggle: (id: string) => void;
}) {
  const isLeaf = node.children.length === 0;
  const isChecked = selectedIds.includes(node.id);

  return (
    <div>
      <label
        className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-[var(--gray-a3)] transition-colors ${
          isLeaf ? '' : 'font-medium'
        }`}
        style={{ paddingLeft: `${depth * 20 + 12}px` }}
      >
        <Checkbox
          checked={isChecked}
          onChange={() => onToggle(node.id)}
        />
        <span className={`text-sm ${isLeaf ? 'text-[var(--gray-11)]' : 'text-[var(--gray-12)]'}`}>
          {node.name}
        </span>
        <span className="text-[10px] text-gray-400 ml-auto">{node.topicCount}</span>
      </label>
      {node.children.map((child) => (
        <CategoryCheckboxTree
          key={child.id}
          node={child}
          depth={depth + 1}
          selectedIds={selectedIds}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}
