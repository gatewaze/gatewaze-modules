/**
 * Menus tab — WordPress-style nestable navigation menus.
 *
 * Per spec-content-modules-git-architecture §11.4:
 *   - Multi-menu picker (Primary, Footer, Mobile, etc.)
 *   - Drag-and-drop tree builder with drag-to-nest
 *   - Real-time save on reorder
 *   - Per-item: label, target (page | external | anchor), visibility,
 *     open in new tab, css classes
 *
 * For v1 the drag-and-drop tree uses a simple nested-list UI (no fancy
 * drag library). Drag-and-drop polish can be a follow-up.
 */

import { useEffect, useState } from 'react';
import { Badge, Button, Card, Input, Select, Modal } from '@/components/ui';
import { Bars3Icon, PlusIcon, TrashIcon, ChevronRightIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import type { SiteRow } from '../../types';

interface MenuRow {
  id: string;
  slug: string;
  name: string;
}

interface MenuItemRow {
  id: string;
  menu_id: string;
  parent_id: string | null;
  order_index: number;
  label: string;
  page_id: string | null;
  external_url: string | null;
  anchor_target: string | null;
  open_in_new_tab: boolean;
  visibility: 'always' | 'authenticated_only' | 'public_only';
  css_classes: string | null;
}

interface PageOption {
  id: string;
  full_path: string;
  title: string;
}

export function SiteMenusTab({ site }: { site: SiteRow }) {
  const [menus, setMenus] = useState<MenuRow[]>([]);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [items, setItems] = useState<MenuItemRow[]>([]);
  const [pages, setPages] = useState<PageOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [newMenuSlug, setNewMenuSlug] = useState('');
  const [newMenuName, setNewMenuName] = useState('');
  const [editingItem, setEditingItem] = useState<Partial<MenuItemRow> | null>(null);
  const [collapsedItems, setCollapsedItems] = useState<Set<string>>(new Set());

  const loadMenus = async () => {
    const { data } = await supabase
      .from('navigation_menus')
      .select('id, slug, name')
      .eq('host_kind', 'site')
      .eq('host_id', site.id)
      .order('slug');
    setMenus((data as MenuRow[]) ?? []);
    if (data && data.length > 0 && !activeMenuId) {
      setActiveMenuId((data as MenuRow[])[0].id);
    }
    setLoading(false);
  };

  const loadItems = async () => {
    if (!activeMenuId) {
      setItems([]);
      return;
    }
    const { data } = await supabase
      .from('navigation_menu_items')
      .select('id, menu_id, parent_id, order_index, label, page_id, external_url, anchor_target, open_in_new_tab, visibility, css_classes')
      .eq('menu_id', activeMenuId)
      .order('order_index');
    setItems((data as MenuItemRow[]) ?? []);
  };

  const loadPages = async () => {
    const { data } = await supabase
      .from('pages')
      .select('id, full_path, title')
      .eq('site_id', site.id)
      .order('full_path');
    setPages((data as PageOption[]) ?? []);
  };

  useEffect(() => {
    loadMenus();
    loadPages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id]);

  useEffect(() => {
    loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMenuId]);

  const onCreateMenu = async () => {
    if (!newMenuSlug.trim() || !newMenuName.trim()) {
      toast.error('Slug and name required');
      return;
    }
    const { data, error } = await supabase
      .from('navigation_menus')
      .insert({
        host_kind: 'site',
        host_id: site.id,
        slug: newMenuSlug.trim(),
        name: newMenuName.trim(),
      })
      .select()
      .single();
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success('Menu created');
    setShowNewMenu(false);
    setNewMenuSlug('');
    setNewMenuName('');
    setMenus((m) => [...m, data as MenuRow]);
    setActiveMenuId((data as MenuRow).id);
  };

  const onAddItem = (parentId: string | null = null) => {
    setEditingItem({
      menu_id: activeMenuId ?? undefined,
      parent_id: parentId,
      order_index: items.filter((i) => i.parent_id === parentId).length,
      label: '',
      page_id: null,
      external_url: null,
      anchor_target: null,
      open_in_new_tab: false,
      visibility: 'always',
    });
  };

  const onSaveItem = async () => {
    if (!editingItem || !activeMenuId) return;
    if (!editingItem.label?.trim()) {
      toast.error('Label required');
      return;
    }
    // Exactly one target type
    const targetCount =
      (editingItem.page_id ? 1 : 0) +
      (editingItem.external_url ? 1 : 0) +
      (editingItem.anchor_target ? 1 : 0);
    if (targetCount !== 1) {
      toast.error('Pick exactly one target: page, external URL, or anchor');
      return;
    }
    if (editingItem.id) {
      const { error } = await supabase
        .from('navigation_menu_items')
        .update({
          label: editingItem.label,
          page_id: editingItem.page_id,
          external_url: editingItem.external_url,
          anchor_target: editingItem.anchor_target,
          open_in_new_tab: editingItem.open_in_new_tab,
          visibility: editingItem.visibility,
          css_classes: editingItem.css_classes,
        })
        .eq('id', editingItem.id);
      if (error) toast.error(error.message);
      else toast.success('Updated');
    } else {
      const { error } = await supabase.from('navigation_menu_items').insert({
        menu_id: activeMenuId,
        parent_id: editingItem.parent_id,
        order_index: editingItem.order_index,
        label: editingItem.label,
        page_id: editingItem.page_id,
        external_url: editingItem.external_url,
        anchor_target: editingItem.anchor_target,
        open_in_new_tab: editingItem.open_in_new_tab,
        visibility: editingItem.visibility,
        css_classes: editingItem.css_classes,
      });
      if (error) toast.error(error.message);
      else toast.success('Added');
    }
    setEditingItem(null);
    loadItems();
  };

  const onDeleteItem = async (id: string) => {
    if (!window.confirm('Delete this menu item (and any children)?')) return;
    const { error } = await supabase.from('navigation_menu_items').delete().eq('id', id);
    if (error) toast.error(error.message);
    else {
      toast.success('Deleted');
      loadItems();
    }
  };

  const toggleCollapse = (id: string) => {
    setCollapsedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderItem = (item: MenuItemRow, depth = 0) => {
    const children = items.filter((i) => i.parent_id === item.id);
    const isCollapsed = collapsedItems.has(item.id);
    const targetLabel = item.page_id
      ? `page: ${pages.find((p) => p.id === item.page_id)?.full_path ?? '(deleted)'}`
      : item.external_url
        ? `external: ${item.external_url}`
        : `anchor: ${item.anchor_target}`;
    return (
      <div key={item.id}>
        <div
          className="flex items-center gap-2 py-2 px-3 rounded-md hover:bg-[var(--gray-a3)]"
          style={{ marginLeft: depth * 24 }}
        >
          {children.length > 0 ? (
            <button onClick={() => toggleCollapse(item.id)} className="p-0.5">
              {isCollapsed ? <ChevronRightIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
            </button>
          ) : (
            <span className="w-5" />
          )}
          <Bars3Icon className="size-4 text-[var(--gray-a7)] cursor-grab" />
          <span className="font-medium">{item.label}</span>
          <span className="text-xs text-[var(--gray-a8)] truncate flex-1">{targetLabel}</span>
          {item.visibility !== 'always' && (
            <Badge variant="soft" color="gray" size="1">{item.visibility.replace('_', ' ')}</Badge>
          )}
          <Button variant="ghost" size="1" onClick={() => onAddItem(item.id)}>
            <PlusIcon className="size-3.5" />
          </Button>
          <Button variant="ghost" size="1" onClick={() => setEditingItem(item)}>
            edit
          </Button>
          <Button variant="ghost" size="1" color="error" onClick={() => onDeleteItem(item.id)}>
            <TrashIcon className="size-3.5" />
          </Button>
        </div>
        {!isCollapsed && children.map((c) => renderItem(c, depth + 1))}
      </div>
    );
  };

  if (loading) {
    return <Card><div className="p-8 flex justify-center"><LoadingSpinner /></div></Card>;
  }

  const topLevelItems = items.filter((i) => i.parent_id === null);

  return (
    <div className="space-y-4">
      <Card>
        <div className="p-4 flex items-center gap-3">
          <Select
            value={activeMenuId ?? ''}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setActiveMenuId(e.target.value || null)}
            data={[
              { value: '', label: '— pick a menu —' },
              ...menus.map((m) => ({ value: m.id, label: `${m.name} (${m.slug})` })),
            ]}
            disabled={menus.length === 0}
          />
          <Button onClick={() => setShowNewMenu(true)}>
            <PlusIcon className="size-4" /> New menu
          </Button>
          {activeMenuId && (
            <Button onClick={() => onAddItem(null)} variant="outlined">
              <PlusIcon className="size-4" /> Add item
            </Button>
          )}
        </div>
      </Card>

      {activeMenuId && (
        <Card>
          <div className="p-2">
            {topLevelItems.length === 0 ? (
              <div className="p-8 text-center">
                <Bars3Icon className="mx-auto size-12 text-[var(--gray-a6)]" />
                <h3 className="mt-2 text-sm font-medium">Empty menu</h3>
                <p className="mt-1 text-sm text-[var(--gray-a8)]">Add your first item.</p>
              </div>
            ) : (
              topLevelItems.map((i) => renderItem(i))
            )}
          </div>
        </Card>
      )}

      {/* New menu modal */}
      <Modal
        isOpen={showNewMenu}
        onClose={() => setShowNewMenu(false)}
        title="New menu"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outlined" onClick={() => setShowNewMenu(false)}>Cancel</Button>
            <Button onClick={onCreateMenu}>Create</Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Input label="Slug" placeholder="primary" value={newMenuSlug} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewMenuSlug(e.target.value)} />
          <Input label="Display name" placeholder="Primary navigation" value={newMenuName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewMenuName(e.target.value)} />
        </div>
      </Modal>

      {/* Item editor modal */}
      <Modal
        isOpen={!!editingItem}
        onClose={() => setEditingItem(null)}
        title={editingItem?.id ? 'Edit menu item' : 'Add menu item'}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outlined" onClick={() => setEditingItem(null)}>Cancel</Button>
            <Button onClick={onSaveItem}>Save</Button>
          </div>
        }
      >
        {editingItem && (
          <div className="space-y-4">
            <Input
              label="Label"
              value={editingItem.label ?? ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditingItem({ ...editingItem, label: e.target.value })}
            />
            <Select
              label="Target type"
              value={editingItem.page_id ? 'page' : editingItem.external_url ? 'external' : editingItem.anchor_target ? 'anchor' : ''}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                const v = e.target.value;
                setEditingItem({
                  ...editingItem,
                  page_id: v === 'page' ? editingItem.page_id ?? pages[0]?.id ?? null : null,
                  external_url: v === 'external' ? editingItem.external_url ?? '' : null,
                  anchor_target: v === 'anchor' ? editingItem.anchor_target ?? '' : null,
                });
              }}
              data={[
                { value: '', label: '— pick a target —' },
                { value: 'page', label: 'Internal page' },
                { value: 'external', label: 'External URL' },
                { value: 'anchor', label: 'Anchor on current page' },
              ]}
            />
            {editingItem.page_id !== null && (
              <Select
                label="Page"
                value={editingItem.page_id ?? ''}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setEditingItem({ ...editingItem, page_id: e.target.value })}
                data={pages.map((p) => ({ value: p.id, label: `${p.title} (${p.full_path})` }))}
              />
            )}
            {editingItem.external_url !== null && (
              <Input
                label="External URL"
                value={editingItem.external_url ?? ''}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditingItem({ ...editingItem, external_url: e.target.value })}
                placeholder="https://example.com"
              />
            )}
            {editingItem.anchor_target !== null && (
              <Input
                label="Anchor"
                value={editingItem.anchor_target ?? ''}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditingItem({ ...editingItem, anchor_target: e.target.value })}
                placeholder="#section-id"
              />
            )}
            <Select
              label="Visibility"
              value={editingItem.visibility ?? 'always'}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setEditingItem({ ...editingItem, visibility: e.target.value as MenuItemRow['visibility'] })}
              data={[
                { value: 'always', label: 'Always visible' },
                { value: 'authenticated_only', label: 'Authenticated users only' },
                { value: 'public_only', label: 'Anonymous users only' },
              ]}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={editingItem.open_in_new_tab ?? false}
                onChange={(e) => setEditingItem({ ...editingItem, open_in_new_tab: e.target.checked })}
              />
              Open in new tab
            </label>
            <Input
              label="CSS classes (optional)"
              value={editingItem.css_classes ?? ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditingItem({ ...editingItem, css_classes: e.target.value })}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
