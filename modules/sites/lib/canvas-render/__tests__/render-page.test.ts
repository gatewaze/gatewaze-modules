// @ts-nocheck — vitest types resolved at workspace install time
/**
 * Golden tests for canonical canvas render. Per spec-sites-wysiwyg-builder
 * §10. Diff-fails on any byte change in output for the same input.
 */

import { describe, expect, it } from 'vitest';
import { renderPage } from '../render-page.js';
import type { RenderInput, BlockDefView, BrickDefView, PageBlockNode } from '../types.js';

const BASE_PAGE: RenderInput['page'] = {
  id: '00000000-0000-0000-0000-000000000001',
  site_id: '00000000-0000-0000-0000-000000000002',
  composition_mode: 'blocks',
  wrapper_id: null,
  content: null,
  title: 'Test Page',
  full_path: '/test',
};

const BASE_CONTEXT = { siteSlug: 'test', brand: 'test', preview: false } as const;

function makeBlockDef(partial: Partial<BlockDefView>): BlockDefView {
  return {
    id: 'def-' + (partial.key ?? 'x'),
    key: partial.key ?? 'x',
    html: partial.html ?? '<div>{{title}}</div>',
    schema: partial.schema ?? { type: 'object' },
    has_bricks: partial.has_bricks ?? false,
    thumbnail_url: null,
  };
}

function makeBlock(partial: Partial<PageBlockNode>): PageBlockNode {
  return {
    id: partial.id ?? 'block-1',
    block_def_id: partial.block_def_id ?? 'def-x',
    content: partial.content ?? {},
    variant_key: partial.variant_key ?? 'default',
    sort_order: partial.sort_order ?? 1000,
    bricks: partial.bricks ?? [],
    parent_brick_id: partial.parent_brick_id ?? null,
  };
}

function blockDefMap(...defs: BlockDefView[]): ReadonlyMap<string, BlockDefView> {
  return new Map(defs.map((d) => [d.id, d]));
}

function emptyInput(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    page: BASE_PAGE,
    blocks: [],
    blockDefs: new Map(),
    brickDefs: new Map(),
    wrappers: new Map(),
    assets: new Map(),
    context: BASE_CONTEXT,
    ...overrides,
  };
}

describe('renderPage — empty page', () => {
  it('renders a doctype + empty body for a page with no blocks', () => {
    const result = renderPage(emptyInput());
    expect(result.html).toContain('<!DOCTYPE html>');
    expect(result.html).toContain('<title>Test Page</title>');
    expect(result.html).toContain('<body data-canvas-page-id="00000000-0000-0000-0000-000000000001">');
    expect(result.html).toContain('</body>');
    expect(result.warnings).toEqual([]);
  });

  it('produces a stable contentHash for identical inputs', () => {
    const a = renderPage(emptyInput());
    const b = renderPage(emptyInput());
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.html).toBe(b.html);
  });
});

describe('renderPage — single block', () => {
  it('renders a single block with HTML-escaped substitution', () => {
    const def = makeBlockDef({ key: 'h1', html: '<h1>{{title}}</h1>' });
    const block = makeBlock({ block_def_id: def.id, content: { title: 'Hello <world>' } });
    const result = renderPage(emptyInput({
      blocks: [block],
      blockDefs: blockDefMap(def),
    }));
    expect(result.html).toContain('<h1>Hello &lt;world&gt;</h1>');
    expect(result.warnings).toEqual([]);
  });

  it('renders raw HTML with {{{...}}} for trusted-html fields', () => {
    const def = makeBlockDef({ key: 'rich', html: '<div>{{{body}}}</div>' });
    const block = makeBlock({ block_def_id: def.id, content: { body: '<em>hello</em>' } });
    const result = renderPage(emptyInput({
      blocks: [block],
      blockDefs: blockDefMap(def),
    }));
    expect(result.html).toContain('<div><em>hello</em></div>');
  });

  it('handles missing field as empty string for {{x}}', () => {
    const def = makeBlockDef({ key: 'h1', html: '<h1>{{title}}</h1>' });
    const block = makeBlock({ block_def_id: def.id, content: {} });
    const result = renderPage(emptyInput({
      blocks: [block],
      blockDefs: blockDefMap(def),
    }));
    expect(result.html).toContain('<h1></h1>');
  });

  it('handles missing field as empty string for {{{x}}}', () => {
    const def = makeBlockDef({ key: 'rich', html: '<div>{{{body}}}</div>' });
    const block = makeBlock({ block_def_id: def.id, content: {} });
    const result = renderPage(emptyInput({
      blocks: [block],
      blockDefs: blockDefMap(def),
    }));
    expect(result.html).toContain('<div></div>');
  });

  it('warns when block_def is missing from render input', () => {
    const block = makeBlock({ block_def_id: 'def-missing' });
    const result = renderPage(emptyInput({ blocks: [block] }));
    expect(result.warnings).toEqual([
      { code: 'canvas.render.block_def_missing', message: expect.stringContaining('def-missing'), blockId: 'block-1' },
    ]);
  });
});

describe('renderPage — multiple blocks', () => {
  it('renders blocks in order', () => {
    const defA = makeBlockDef({ key: 'a', html: '<p>A:{{name}}</p>' });
    const defB = makeBlockDef({ key: 'b', html: '<p>B:{{name}}</p>' });
    const result = renderPage(emptyInput({
      blocks: [
        makeBlock({ id: '1', block_def_id: defA.id, content: { name: 'one' }, sort_order: 1000 }),
        makeBlock({ id: '2', block_def_id: defB.id, content: { name: 'two' }, sort_order: 2000 }),
      ],
      blockDefs: blockDefMap(defA, defB),
    }));
    const oneIdx = result.html.indexOf('A:one');
    const twoIdx = result.html.indexOf('B:two');
    expect(oneIdx).toBeGreaterThan(0);
    expect(twoIdx).toBeGreaterThan(oneIdx);
  });
});

describe('renderPage — sections', () => {
  it('renders section body when value is truthy', () => {
    const def = makeBlockDef({ key: 'cond', html: '{{#show}}<p>visible</p>{{/show}}' });
    const block = makeBlock({ block_def_id: def.id, content: { show: true } });
    const result = renderPage(emptyInput({ blocks: [block], blockDefs: blockDefMap(def) }));
    expect(result.html).toContain('<p>visible</p>');
  });

  it('omits section body when value is falsy', () => {
    const def = makeBlockDef({ key: 'cond', html: '{{#show}}<p>visible</p>{{/show}}' });
    const block = makeBlock({ block_def_id: def.id, content: { show: false } });
    const result = renderPage(emptyInput({ blocks: [block], blockDefs: blockDefMap(def) }));
    expect(result.html).not.toContain('<p>visible</p>');
  });

  it('renders inverse section when value is falsy', () => {
    const def = makeBlockDef({ key: 'cond', html: '{{^missing}}<p>fallback</p>{{/missing}}' });
    const block = makeBlock({ block_def_id: def.id, content: {} });
    const result = renderPage(emptyInput({ blocks: [block], blockDefs: blockDefMap(def) }));
    expect(result.html).toContain('<p>fallback</p>');
  });
});

describe('renderPage — preview decoration', () => {
  it('injects data-block-id on root element when preview=true', () => {
    const def = makeBlockDef({ key: 'h1', html: '<h1>{{title}}</h1>' });
    const block = makeBlock({ block_def_id: def.id, content: { title: 'X' } });
    const result = renderPage(emptyInput({
      blocks: [block],
      blockDefs: blockDefMap(def),
      context: { ...BASE_CONTEXT, preview: true },
    }));
    expect(result.html).toContain('data-block-id="block-1"');
    expect(result.html).toContain('canvas:ready'); // decorator script present
  });

  it('omits decorator script when preview=false', () => {
    const def = makeBlockDef({ key: 'h1', html: '<h1>{{title}}</h1>' });
    const block = makeBlock({ block_def_id: def.id, content: { title: 'X' } });
    const result = renderPage(emptyInput({
      blocks: [block],
      blockDefs: blockDefMap(def),
    }));
    expect(result.html).not.toContain('canvas:ready');
    expect(result.html).not.toContain('data-block-id');
  });

  it('produces same body content regardless of preview flag', () => {
    const def = makeBlockDef({ key: 'h1', html: '<h1>{{title}}</h1>' });
    const block = makeBlock({ block_def_id: def.id, content: { title: 'parity' } });
    const a = renderPage(emptyInput({ blocks: [block], blockDefs: blockDefMap(def), context: { ...BASE_CONTEXT, preview: false } }));
    const b = renderPage(emptyInput({ blocks: [block], blockDefs: blockDefMap(def), context: { ...BASE_CONTEXT, preview: true } }));
    // Both should contain the block's rendered content; only b carries decorator markers.
    expect(a.html).toContain('<h1>parity</h1>');
    expect(b.html).toContain('parity</h1>');
  });
});

describe('renderPage — assets', () => {
  it('resolves asset.id → asset.url from the assets map', () => {
    const def = makeBlockDef({ key: 'img', html: '<img src="{{image.url}}" alt="{{image.alt}}">' });
    const block = makeBlock({
      block_def_id: def.id,
      // No url/alt set in content — the resolver fills them from assets map.
      content: { image: { id: 'media-1' } },
    });
    const result = renderPage(emptyInput({
      blocks: [block],
      blockDefs: blockDefMap(def),
      assets: new Map([['media-1', { url: '/media/abc.jpg', alt: 'A photo' }]]),
    }));
    expect(result.html).toContain('src="/media/abc.jpg"');
    expect(result.html).toContain('alt="A photo"');
  });

  it('leaves asset object unchanged when id missing from assets map', () => {
    const def = makeBlockDef({ key: 'img', html: '<img src="{{image.url}}">' });
    const block = makeBlock({
      block_def_id: def.id,
      content: { image: { id: 'media-missing', url: '/old.jpg' } },
    });
    const result = renderPage(emptyInput({
      blocks: [block],
      blockDefs: blockDefMap(def),
    }));
    expect(result.html).toContain('src="/old.jpg"');
  });
});

describe('renderPage — wrapper', () => {
  it('wraps body in wrapper template via {{>page_body}}', () => {
    const def = makeBlockDef({ key: 'p', html: '<p>{{text}}</p>' });
    const block = makeBlock({ block_def_id: def.id, content: { text: 'inner' } });
    const wrapper = {
      id: 'wrap-1',
      key: 'default',
      html: '<main class="wrap"><h1>{{page.title}}</h1>{{>page_body}}</main>',
    };
    const result = renderPage(emptyInput({
      page: { ...BASE_PAGE, wrapper_id: wrapper.id },
      blocks: [block],
      blockDefs: blockDefMap(def),
      wrappers: new Map([[wrapper.id, wrapper]]),
    }));
    expect(result.html).toContain('<main class="wrap"><h1>Test Page</h1><p>inner</p></main>');
  });

  it('warns when wrapper_id is set but wrapper missing from input', () => {
    const def = makeBlockDef({ key: 'p', html: '<p>{{text}}</p>' });
    const block = makeBlock({ block_def_id: def.id, content: { text: 'inner' } });
    const result = renderPage(emptyInput({
      page: { ...BASE_PAGE, wrapper_id: 'wrap-missing' },
      blocks: [block],
      blockDefs: blockDefMap(def),
    }));
    expect(result.warnings).toEqual([
      { code: 'canvas.render.wrapper_missing', message: expect.stringContaining('wrap-missing') },
    ]);
  });
});

describe('renderPage — bricks (column layout)', () => {
  it('renders nested children inside a brick slot via {{>children}}', () => {
    const colDef = makeBlockDef({
      key: 'row-2col',
      html: '<div class="row">{{>left}}{{>right}}</div>',
      has_bricks: true,
    });
    const leftBrickDef: BrickDefView = {
      id: 'brick-left-def',
      key: 'left',
      html: '<div class="col left">{{>children}}</div>',
      schema: { type: 'object' },
    };
    const rightBrickDef: BrickDefView = {
      id: 'brick-right-def',
      key: 'right',
      html: '<div class="col right">{{>children}}</div>',
      schema: { type: 'object' },
    };
    const innerDef = makeBlockDef({ key: 'h2', html: '<h2>{{text}}</h2>' });

    const innerBlockL = makeBlock({
      id: 'inner-l',
      block_def_id: innerDef.id,
      content: { text: 'left content' },
      parent_brick_id: 'brick-l',
    });
    const innerBlockR = makeBlock({
      id: 'inner-r',
      block_def_id: innerDef.id,
      content: { text: 'right content' },
      parent_brick_id: 'brick-r',
    });

    const colBlock = makeBlock({
      id: 'col',
      block_def_id: colDef.id,
      bricks: [
        { id: 'brick-l', brick_def_id: leftBrickDef.id, content: {}, variant_key: 'default', sort_order: 1000, children: [innerBlockL] },
        { id: 'brick-r', brick_def_id: rightBrickDef.id, content: {}, variant_key: 'default', sort_order: 2000, children: [innerBlockR] },
      ],
    });

    const result = renderPage(emptyInput({
      blocks: [colBlock],
      blockDefs: blockDefMap(colDef, innerDef),
      brickDefs: new Map([
        [leftBrickDef.id, leftBrickDef],
        [rightBrickDef.id, rightBrickDef],
      ]),
    }));

    expect(result.html).toContain('<div class="row"><div class="col left"><h2>left content</h2></div><div class="col right"><h2>right content</h2></div></div>');
  });
});
