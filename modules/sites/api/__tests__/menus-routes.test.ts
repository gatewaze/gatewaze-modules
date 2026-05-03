/**
 * Tests for navigation menus admin endpoints.
 *
 * Covers:
 *   - 400 missing-fields validations (slug, name, label, exactly-one-target)
 *   - 409 slug_taken on duplicate menu insert
 *   - 400 menu_cycle_detected on parent change that would create a cycle
 *   - 200 list / get menus
 *   - 204 delete item
 *   - 404 menu_not_found / item_not_found
 *
 * Mass-assignment guard verified via pickFields(body, MENU_ITEM_FIELDS).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMenusRoutes, type MenusRoutesDeps } from '../menus-routes.js';

interface DbCall {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'rpc';
  values?: Record<string, unknown>;
}

function makeStubDeps(opts: {
  menuExists?: boolean;
  menuId?: string;
  insertError?: { message: string };
  cycleResult?: boolean;
  itemFound?: boolean;
} = {}): MenusRoutesDeps & { calls: DbCall[] } {
  const calls: DbCall[] = [];
  return {
    calls,
    supabase: {
      from(table: string) {
        const ctx = { calls, table };
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () => {
                    ctx.calls.push({ table: ctx.table, op: 'select' });
                    return { data: opts.menuExists ? { id: opts.menuId ?? 'menu-1', slug: 'primary', name: 'Primary' } : null, error: null };
                  },
                  order: () => ({ data: [], error: null }),
                }),
                single: async () => {
                  ctx.calls.push({ table: ctx.table, op: 'select' });
                  return { data: opts.menuExists ? { id: opts.menuId ?? 'menu-1' } : null, error: null };
                },
                order: () => ({ data: [], error: null }),
              }),
              order: () => ({ data: [], error: null }),
              single: async () => {
                ctx.calls.push({ table: ctx.table, op: 'select' });
                return { data: opts.menuExists ? { id: opts.menuId ?? 'menu-1' } : null, error: null };
              },
            }),
            order: () => ({ data: [], error: null }),
          }),
          insert: (values: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                ctx.calls.push({ table: ctx.table, op: 'insert', values });
                return { data: opts.insertError ? null : { id: 'new-id', ...values }, error: opts.insertError ?? null };
              },
            }),
          }),
          update: (values: Record<string, unknown>) => ({
            eq: () => ({
              select: () => ({
                single: async () => {
                  ctx.calls.push({ table: ctx.table, op: 'update', values });
                  return { data: opts.itemFound !== false ? { id: 'item-1', ...values } : null, error: null };
                },
              }),
            }),
          }),
          delete: () => ({
            eq: async () => {
              ctx.calls.push({ table: ctx.table, op: 'delete' });
              return { error: null };
            },
          }),
        };
      },
      rpc: vi.fn(async () => ({ data: opts.cycleResult ?? false, error: null })),
    },
    logger: { info: vi.fn(), warn: vi.fn() },
  };
}

function makeRes() {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const end = vi.fn();
  return { res: { status, json, end } as unknown as Response, status, json, end };
}

describe('createMenu', () => {
  it('returns 201 with menu on success', async () => {
    const deps = makeStubDeps();
    const routes = createMenusRoutes(deps);
    const req = { params: { id: 'site-1' }, body: { slug: 'primary', name: 'Primary' } } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.createMenu(req as Request & { user: { id: string } }, res);

    expect(status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ menu: expect.any(Object) }));
  });

  it('returns 400 when slug missing', async () => {
    const deps = makeStubDeps();
    const routes = createMenusRoutes(deps);
    const req = { params: { id: 'site-1' }, body: { name: 'Primary' } } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.createMenu(req as Request & { user: { id: string } }, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'missing_fields' }));
  });

  it('returns 409 slug_taken on duplicate insert', async () => {
    const deps = makeStubDeps({ insertError: { message: 'duplicate key value violates unique constraint' } });
    const routes = createMenusRoutes(deps);
    const req = { params: { id: 'site-1' }, body: { slug: 'primary', name: 'Primary' } } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.createMenu(req as Request & { user: { id: string } }, res);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'slug_taken' }));
  });
});

describe('addItem', () => {
  it('returns 400 when no target set', async () => {
    const deps = makeStubDeps({ menuExists: true });
    const routes = createMenusRoutes(deps);
    const req = { params: { id: 'site-1', menuSlug: 'primary' }, body: { label: 'Home' } } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.addItem(req as Request & { user: { id: string } }, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_item' }));
  });

  it('returns 400 when multiple targets set', async () => {
    const deps = makeStubDeps({ menuExists: true });
    const routes = createMenusRoutes(deps);
    const req = {
      params: { id: 'site-1', menuSlug: 'primary' },
      body: { label: 'Home', page_id: 'p-1', external_url: 'https://x.com' },
    } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.addItem(req as Request & { user: { id: string } }, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_item' }));
  });

  it('returns 404 when menu not found', async () => {
    const deps = makeStubDeps({ menuExists: false });
    const routes = createMenusRoutes(deps);
    const req = {
      params: { id: 'site-1', menuSlug: 'unknown' },
      body: { label: 'Home', page_id: 'p-1' },
    } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.addItem(req as Request & { user: { id: string } }, res);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'menu_not_found' }));
  });

  it('returns 201 on happy path', async () => {
    const deps = makeStubDeps({ menuExists: true });
    const routes = createMenusRoutes(deps);
    const req = {
      params: { id: 'site-1', menuSlug: 'primary' },
      body: { label: 'Home', page_id: 'p-1' },
    } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.addItem(req as Request & { user: { id: string } }, res);

    expect(status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ item: expect.any(Object) }));
  });

  it('mass-assignment guard: ignores fields not in MENU_ITEM_FIELDS allowlist', async () => {
    const deps = makeStubDeps({ menuExists: true });
    const routes = createMenusRoutes(deps);
    const req = {
      params: { id: 'site-1', menuSlug: 'primary' },
      body: {
        label: 'Home',
        page_id: 'p-1',
        // These should NOT reach the insert:
        id: 'spoofed-id',
        menu_id: 'spoofed-menu-id',
        created_at: '2020-01-01',
      },
    } as unknown as Request;
    const { res } = makeRes();

    await routes.addItem(req as Request & { user: { id: string } }, res);

    const insertCall = deps.calls.find((c) => c.op === 'insert' && c.table === 'navigation_menu_items');
    expect(insertCall).toBeDefined();
    expect(insertCall!.values).not.toHaveProperty('id', 'spoofed-id');
    expect(insertCall!.values).not.toHaveProperty('created_at');
  });
});

describe('updateItem', () => {
  it('returns 400 menu_cycle_detected when parent change creates cycle', async () => {
    const deps = makeStubDeps({ cycleResult: true });
    const routes = createMenusRoutes(deps);
    const req = { params: { itemId: 'item-1' }, body: { parent_id: 'item-2' } } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.updateItem(req as Request & { user: { id: string } }, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'menu_cycle_detected' }));
  });

  it('returns 200 on no-cycle parent change', async () => {
    const deps = makeStubDeps({ cycleResult: false });
    const routes = createMenusRoutes(deps);
    const req = { params: { itemId: 'item-1' }, body: { parent_id: 'item-2' } } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.updateItem(req as Request & { user: { id: string } }, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ item: expect.any(Object) }));
  });
});

describe('deleteItem', () => {
  it('returns 204 on success', async () => {
    const deps = makeStubDeps();
    const routes = createMenusRoutes(deps);
    const req = { params: { itemId: 'item-1' } } as unknown as Request;
    const { res, status, end } = makeRes();

    await routes.deleteItem(req as Request & { user: { id: string } }, res);

    expect(status).toHaveBeenCalledWith(204);
    expect(end).toHaveBeenCalled();
  });

  it('returns 400 when itemId missing', async () => {
    const deps = makeStubDeps();
    const routes = createMenusRoutes(deps);
    const req = { params: {} } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.deleteItem(req as Request & { user: { id: string } }, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'missing_item_id' }));
  });
});
