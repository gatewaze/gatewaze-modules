/**
 * Navigation menus admin endpoints.
 *
 * Per spec-content-modules-git-architecture §22.5:
 *
 *   POST   /admin/sites/:id/menus                            — create menu
 *   GET    /admin/sites/:id/menus                            — list menus
 *   GET    /admin/sites/:id/menus/:menuSlug                  — fetch menu tree
 *   PUT    /admin/sites/:id/menus/:menuSlug/items            — bulk replace tree
 *   POST   /admin/sites/:id/menus/:menuSlug/items            — single item add
 *   PATCH  /admin/sites/:id/menus/:menuSlug/items/:itemId    — single item update
 *   DELETE /admin/sites/:id/menus/:menuSlug/items/:itemId    — single item delete
 *
 * Cycle prevention enforced via menu_item_would_cycle() RPC (created in
 * sites/016_navigation_menus.sql).
 */

import type { Request, Response, Router } from 'express';

interface RequestWithUser extends Request {
  user?: { id: string };
}

interface ErrorEnvelope {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

interface MenuItemInput {
  parent_id?: string | null;
  order_index?: number;
  label: string;
  page_id?: string | null;
  external_url?: string | null;
  anchor_target?: string | null;
  open_in_new_tab?: boolean;
  rel_attributes?: string[];
  css_classes?: string | null;
  visibility?: 'always' | 'authenticated_only' | 'public_only';
}

const MENU_ITEM_FIELDS = [
  'parent_id', 'order_index', 'label', 'page_id', 'external_url', 'anchor_target',
  'open_in_new_tab', 'rel_attributes', 'css_classes', 'visibility',
] as const;

function pickFields<T extends Record<string, unknown>>(body: T, allowed: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of allowed) {
    if (k in body) out[k] = body[k];
  }
  return out;
}

function paramAs(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return undefined;
}

function validateExactlyOneTarget(item: Partial<MenuItemInput>): string | null {
  const set = (item.page_id ? 1 : 0) + (item.external_url ? 1 : 0) + (item.anchor_target ? 1 : 0);
  if (set !== 1) {
    return 'menu item must have exactly one of: page_id, external_url, anchor_target';
  }
  return null;
}

export interface MenusRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export function createMenusRoutes(deps: MenusRoutesDeps) {
  const { supabase } = deps;

  async function createMenu(req: RequestWithUser, res: Response): Promise<void> {
    const siteId = paramAs(req.params.id);
    if (!siteId) {
      res.status(400).json({ error: 'missing_site_id', message: 'site id required' } satisfies ErrorEnvelope);
      return;
    }
    const body = req.body ?? {};
    const slug = typeof body.slug === 'string' ? body.slug : '';
    const name = typeof body.name === 'string' ? body.name : '';
    if (!slug || !name) {
      res.status(400).json({ error: 'missing_fields', message: 'slug and name required' } satisfies ErrorEnvelope);
      return;
    }
    const result = await supabase
      .from('navigation_menus')
      .insert({ host_kind: 'site', host_id: siteId, slug, name })
      .select()
      .single();
    if (result.error) {
      const message = String(result.error.message ?? '');
      if (message.includes('duplicate')) {
        res.status(409).json({ error: 'slug_taken', message: `menu slug '${slug}' already exists for this site` } satisfies ErrorEnvelope);
        return;
      }
      res.status(500).json({ error: 'db_error', message } satisfies ErrorEnvelope);
      return;
    }
    res.status(201).json({ menu: result.data });
  }

  async function listMenus(req: Request, res: Response): Promise<void> {
    const siteId = paramAs(req.params.id);
    if (!siteId) {
      res.status(400).json({ error: 'missing_site_id', message: 'site id required' } satisfies ErrorEnvelope);
      return;
    }
    const result = await supabase
      .from('navigation_menus')
      .select('id, slug, name, created_at, updated_at')
      .eq('host_kind', 'site')
      .eq('host_id', siteId)
      .order('slug');
    res.status(200).json({ menus: result.data ?? [] });
  }

  async function getMenu(req: Request, res: Response): Promise<void> {
    const siteId = paramAs(req.params.id);
    const menuSlug = paramAs(req.params.menuSlug);
    if (!siteId || !menuSlug) {
      res.status(400).json({ error: 'missing_params', message: 'site id and menu slug required' } satisfies ErrorEnvelope);
      return;
    }
    const menuResult = await supabase
      .from('navigation_menus')
      .select('id, slug, name')
      .eq('host_kind', 'site').eq('host_id', siteId).eq('slug', menuSlug)
      .single();
    const menu = menuResult.data as { id: string; slug: string; name: string } | null;
    if (!menu) {
      res.status(404).json({ error: 'menu_not_found', message: `no menu '${menuSlug}' for site` } satisfies ErrorEnvelope);
      return;
    }
    const itemsResult = await supabase
      .from('navigation_menu_items')
      .select('id, parent_id, order_index, label, page_id, external_url, anchor_target, open_in_new_tab, rel_attributes, css_classes, visibility')
      .eq('menu_id', menu.id)
      .order('order_index');
    res.status(200).json({ menu, tree: itemsResult.data ?? [] });
  }

  async function bulkReplaceItems(req: RequestWithUser, res: Response): Promise<void> {
    const siteId = paramAs(req.params.id);
    const menuSlug = paramAs(req.params.menuSlug);
    if (!siteId || !menuSlug) {
      res.status(400).json({ error: 'missing_params', message: 'site id and menu slug required' } satisfies ErrorEnvelope);
      return;
    }
    const body = req.body ?? {};
    const items: MenuItemInput[] = Array.isArray(body.items) ? body.items : [];
    // Validate each item
    for (const i of items) {
      const tgtErr = validateExactlyOneTarget(i);
      if (tgtErr) {
        res.status(400).json({ error: 'invalid_item', message: tgtErr } satisfies ErrorEnvelope);
        return;
      }
    }

    // Lookup menu id
    const menuResult = await supabase
      .from('navigation_menus')
      .select('id')
      .eq('host_kind', 'site').eq('host_id', siteId).eq('slug', menuSlug)
      .single();
    const menu = menuResult.data as { id: string } | null;
    if (!menu) {
      res.status(404).json({ error: 'menu_not_found', message: `no menu '${menuSlug}'` } satisfies ErrorEnvelope);
      return;
    }

    // Atomic replace: delete existing, insert new in single RPC
    const { error: rpcErr } = await supabase.rpc('navigation_menu_replace_items', {
      p_menu_id: menu.id,
      p_items: items.map((i) => pickFields(i as unknown as Record<string, unknown>, MENU_ITEM_FIELDS)),
    });
    if (rpcErr) {
      const message = String(rpcErr.message ?? '');
      if (message.includes('cycle')) {
        res.status(400).json({ error: 'menu_cycle_detected', message } satisfies ErrorEnvelope);
        return;
      }
      res.status(500).json({ error: 'db_error', message } satisfies ErrorEnvelope);
      return;
    }
    // Re-fetch + return
    const itemsResult = await supabase
      .from('navigation_menu_items')
      .select('id, parent_id, order_index, label, page_id, external_url, anchor_target, open_in_new_tab, rel_attributes, css_classes, visibility')
      .eq('menu_id', menu.id)
      .order('order_index');
    res.status(200).json({ tree: itemsResult.data ?? [] });
  }

  async function addItem(req: RequestWithUser, res: Response): Promise<void> {
    const siteId = paramAs(req.params.id);
    const menuSlug = paramAs(req.params.menuSlug);
    if (!siteId || !menuSlug) {
      res.status(400).json({ error: 'missing_params', message: 'site id and menu slug required' } satisfies ErrorEnvelope);
      return;
    }
    const body = req.body ?? {};
    const item = pickFields(body, MENU_ITEM_FIELDS) as unknown as MenuItemInput;
    const tgtErr = validateExactlyOneTarget(item);
    if (tgtErr) {
      res.status(400).json({ error: 'invalid_item', message: tgtErr } satisfies ErrorEnvelope);
      return;
    }

    const menuResult = await supabase
      .from('navigation_menus').select('id')
      .eq('host_kind', 'site').eq('host_id', siteId).eq('slug', menuSlug).single();
    const menu = menuResult.data as { id: string } | null;
    if (!menu) {
      res.status(404).json({ error: 'menu_not_found', message: `no menu '${menuSlug}'` } satisfies ErrorEnvelope);
      return;
    }

    // Cycle check (only relevant if parent_id set + we're updating; on insert
    // the new id doesn't exist yet so no cycle possible)
    const inserted = await supabase
      .from('navigation_menu_items')
      .insert({ menu_id: menu.id, ...item })
      .select()
      .single();
    if (inserted.error) {
      res.status(500).json({ error: 'db_error', message: inserted.error.message } satisfies ErrorEnvelope);
      return;
    }
    res.status(201).json({ item: inserted.data });
  }

  async function updateItem(req: RequestWithUser, res: Response): Promise<void> {
    const itemId = paramAs(req.params.itemId);
    if (!itemId) {
      res.status(400).json({ error: 'missing_item_id', message: 'item id required' } satisfies ErrorEnvelope);
      return;
    }
    const body = req.body ?? {};
    const patch = pickFields(body, MENU_ITEM_FIELDS);

    // Cycle check on parent change
    if ('parent_id' in patch && patch.parent_id) {
      const cycleResult = await supabase.rpc('menu_item_would_cycle', {
        p_item_id: itemId,
        p_new_parent_id: patch.parent_id,
      });
      if (cycleResult.data === true) {
        res.status(400).json({ error: 'menu_cycle_detected', message: 'this parent assignment would create a cycle' } satisfies ErrorEnvelope);
        return;
      }
    }

    const updated = await supabase
      .from('navigation_menu_items')
      .update(patch)
      .eq('id', itemId)
      .select()
      .single();
    if (updated.error) {
      res.status(500).json({ error: 'db_error', message: updated.error.message } satisfies ErrorEnvelope);
      return;
    }
    if (!updated.data) {
      res.status(404).json({ error: 'item_not_found', message: 'menu item not found' } satisfies ErrorEnvelope);
      return;
    }
    res.status(200).json({ item: updated.data });
  }

  async function deleteItem(req: RequestWithUser, res: Response): Promise<void> {
    const itemId = paramAs(req.params.itemId);
    if (!itemId) {
      res.status(400).json({ error: 'missing_item_id', message: 'item id required' } satisfies ErrorEnvelope);
      return;
    }
    const result = await supabase.from('navigation_menu_items').delete().eq('id', itemId);
    if (result.error) {
      res.status(500).json({ error: 'db_error', message: result.error.message } satisfies ErrorEnvelope);
      return;
    }
    res.status(204).end();
  }

  return { createMenu, listMenus, getMenu, bulkReplaceItems, addItem, updateItem, deleteItem };
}

export function mountMenusRoutes(router: Router, routes: ReturnType<typeof createMenusRoutes>): void {
  router.post('/sites/:id/menus', routes.createMenu);
  router.get('/sites/:id/menus', routes.listMenus);
  router.get('/sites/:id/menus/:menuSlug', routes.getMenu);
  router.put('/sites/:id/menus/:menuSlug/items', routes.bulkReplaceItems);
  router.post('/sites/:id/menus/:menuSlug/items', routes.addItem);
  router.patch('/sites/:id/menus/:menuSlug/items/:itemId', routes.updateItem);
  router.delete('/sites/:id/menus/:menuSlug/items/:itemId', routes.deleteItem);
}
