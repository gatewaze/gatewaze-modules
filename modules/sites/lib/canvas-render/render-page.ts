/**
 * Canonical render — the single authoritative renderer used by the canvas
 * editor (server-side) and (Phase 2) the publish-worker. Per
 * spec-sites-wysiwyg-builder §5.1.
 *
 * Constraints:
 *   - Pure, deterministic. No fetch, no Date.now, no Math.random.
 *   - No dependencies on Vite, Next.js, or admin/portal code.
 *   - Output is byte-identical for the same input across processes.
 *   - context.preview affects ONLY the decoration layer (script injection,
 *     data-* attribute pass-through, omit analytics tags). Body content
 *     is identical regardless.
 */

import { createHash } from 'node:crypto';
import { renderTemplate } from './mustache-subset.js';
import type {
  RenderInput,
  RenderResult,
  RenderWarning,
  PageBlockNode,
  PageBrickNode,
  BlockDefView,
  BrickDefView,
} from './types.js';

export function renderPage(input: RenderInput): RenderResult {
  const warnings: RenderWarning[] = [];

  const bodyHtml = renderBlocks(input.blocks, input, warnings);

  const wrapperHtml = wrapBody(bodyHtml, input, warnings);

  const html = composeDocument(wrapperHtml, input);

  return {
    html,
    contentHash: sha256(html),
    warnings,
  };
}

function renderBlocks(
  blocks: ReadonlyArray<PageBlockNode>,
  input: RenderInput,
  warnings: RenderWarning[],
): string {
  let out = '';
  for (const block of blocks) {
    const def = input.blockDefs.get(block.block_def_id);
    if (!def) {
      warnings.push({
        code: 'canvas.render.block_def_missing',
        message: `block_def ${block.block_def_id} not found in render input`,
        blockId: block.id,
      });
      continue;
    }
    out += renderOneBlock(block, def, input, warnings);
  }
  return out;
}

function renderOneBlock(
  block: PageBlockNode,
  def: BlockDefView,
  input: RenderInput,
  warnings: RenderWarning[],
): string {
  // Resolve which variant content to render.
  // Priority: selectedBlockVariants override → block.variant_key → 'default'.
  // If the resolved variant_key is anything other than 'default' AND a
  // matching override exists in input.blockVariants, use it; otherwise
  // fall back to block.content (the canonical default).
  const effectiveContent = resolveVariantContent(
    block.id, block.variant_key, block.content, input.selectedBlockVariants, input.blockVariants,
  );

  // Resolve assets in content (for fields with format: site-media-id).
  const resolvedContent = resolveAssets(effectiveContent, def.schema, input);

  // Build {{>children}} partials per brick slot.
  const childrenPartials = buildBrickPartials(block.bricks, input, warnings);

  const inner = renderTemplate(def.html, resolvedContent, { partials: childrenPartials });

  // Wrap with editor decorator attributes when in preview mode.
  if (input.context.preview) {
    return wrapWithEditorAttrs(inner, block.id);
  }
  return inner;
}

/**
 * Pick the content payload for a block or brick given the selected
 * variant. Returns the override when one exists for the resolved
 * variant_key; otherwise returns the default. Pure function — same
 * inputs ⇒ same output.
 */
function resolveVariantContent(
  nodeId: string,
  storedVariantKey: string,
  defaultContent: Record<string, unknown>,
  selected: ReadonlyMap<string, string> | undefined,
  variants: ReadonlyMap<string, ReadonlyMap<string, Record<string, unknown>>> | undefined,
): Record<string, unknown> {
  const variantKey = selected?.get(nodeId) ?? storedVariantKey ?? 'default';
  if (variantKey === 'default') return defaultContent;
  const override = variants?.get(nodeId)?.get(variantKey);
  return override ?? defaultContent;
}

function buildBrickPartials(
  bricks: ReadonlyArray<PageBrickNode>,
  input: RenderInput,
  warnings: RenderWarning[],
): ReadonlyMap<string, string> {
  // Map of brick.key → rendered children HTML (for {{>children}}).
  // Multiple bricks of the same key concatenate; the brick template itself
  // wraps the children, so the partial body is just the children HTML.
  const out = new Map<string, string>();
  for (const brick of bricks) {
    const def = input.brickDefs.get(brick.brick_def_id);
    if (!def) {
      warnings.push({
        code: 'canvas.render.brick_def_missing',
        message: `brick_def ${brick.brick_def_id} not found in render input`,
      });
      continue;
    }
    const childrenHtml = renderBlocks(brick.children, input, warnings);
    const effectiveBrickContent = resolveVariantContent(
      brick.id, brick.variant_key, brick.content, input.selectedBlockVariants, input.brickVariants,
    );
    // Render the brick's html template; provide childrenHtml as {{>children}}.
    const brickHtml = renderTemplate(def.html, effectiveBrickContent, {
      partials: new Map([['children', childrenHtml]]),
    });
    // Concatenate against any prior brick at the same key.
    const prior = out.get(def.key) ?? '';
    out.set(def.key, prior + brickHtml);
  }
  return out;
}

function resolveAssets(
  content: Record<string, unknown>,
  _schema: Record<string, unknown>,
  input: RenderInput,
): Record<string, unknown> {
  // Walk content and resolve any {id, url?, alt?} object whose `id` matches a
  // sites_media entry; rewrite `url` to the resolved URL.
  // This avoids storing the resolved URL in content (per spec §4.7).
  return walkAndResolve(content, input.assets) as Record<string, unknown>;
}

function walkAndResolve(value: unknown, assets: ReadonlyMap<string, { url: string; alt?: string }>): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => walkAndResolve(v, assets));
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Asset shape: { id: string, ... } where id matches an entry in the
    // assets map. The id-membership check avoids false positives on
    // unrelated objects that happen to have an `id` field.
    if (typeof obj.id === 'string' && assets.has(obj.id)) {
      const resolved = assets.get(obj.id)!;
      return {
        ...obj,
        url: resolved.url,
        alt: obj.alt ?? resolved.alt ?? '',
      };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = walkAndResolve(v, assets);
    }
    return out;
  }
  return value;
}

function wrapBody(
  bodyHtml: string,
  input: RenderInput,
  warnings: RenderWarning[],
): string {
  const wrapperId = input.page.wrapper_id;
  if (!wrapperId) return bodyHtml;
  const wrapper = input.wrappers.get(wrapperId);
  if (!wrapper) {
    warnings.push({
      code: 'canvas.render.wrapper_missing',
      message: `wrapper ${wrapperId} not found in render input`,
    });
    return bodyHtml;
  }
  const view = {
    page: { title: input.page.title, full_path: input.page.full_path },
  };
  return renderTemplate(wrapper.html, view, {
    partials: new Map([['page_body', bodyHtml]]),
  });
}

function wrapWithEditorAttrs(innerHtml: string, blockId: string): string {
  // Inject data-block-id on the OUTERMOST element of the rendered block.
  // The block_def contract requires data-block-root on the root, so we splice
  // data-block-id alongside it.
  // Heuristic: insert after the first '<' + tagName run.
  const m = innerHtml.match(/^\s*<([a-zA-Z][a-zA-Z0-9-]*)([\s>])/);
  if (!m) return innerHtml;
  const tag = m[1];
  const attrInsert = ` data-block-id="${escapeAttrValue(blockId)}"`;
  const insertAt = (m.index ?? 0) + 1 + tag.length;
  return innerHtml.slice(0, insertAt) + attrInsert + innerHtml.slice(insertAt);
}

function composeDocument(bodyHtml: string, input: RenderInput): string {
  const csp =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'self'";
  const decorator = input.context.preview ? CANVAS_DECORATOR_SCRIPT : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttrValue(csp)}">
<title>${escapeAttrValue(input.page.title)}</title>
${decorator}
</head>
<body data-canvas-page-id="${escapeAttrValue(input.page.id)}">
${bodyHtml}
</body>
</html>`;
}

function escapeAttrValue(s: string): string {
  return s.replace(/"/g, '&quot;');
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Decorator script injected into the iframe srcdoc when context.preview=true.
 * Wires inline-edit (contenteditable on data-field elements) and selection
 * tracking (postMessage out of iframe). Runs entirely inside the iframe.
 *
 * Kept inline as a string so the canonical-render module has zero file I/O
 * dependencies (per §5.1 constraint). When the script grows beyond a few
 * dozen lines, we'll extract it to a sibling .js file and embed via
 * `readFileSync` at module load time (not per-render).
 */
const CANVAS_DECORATOR_SCRIPT = `<script>
(function () {
  'use strict';
  function isFromParent(e) { return e.source === window.parent; }
  function postToParent(msg) { window.parent.postMessage(msg, window.origin); }

  // Wire data-field elements as contenteditable on click.
  document.addEventListener('click', function (ev) {
    var el = ev.target;
    while (el && el.nodeType === 1) {
      if (el.hasAttribute && el.hasAttribute('data-field')) {
        if (el.contentEditable !== 'true') {
          el.contentEditable = 'true';
          el.focus();
          var blockEl = el.closest('[data-block-id]');
          var blockId = blockEl ? blockEl.getAttribute('data-block-id') : null;
          postToParent({
            type: 'canvas:selection',
            blockId: blockId,
            fieldPath: el.getAttribute('data-field'),
            edit: el.getAttribute('data-edit') || 'plain',
          });
        }
        return;
      }
      el = el.parentNode;
    }
  });

  // On blur of a contenteditable, commit the edit.
  document.addEventListener('blur', function (ev) {
    var el = ev.target;
    if (el && el.contentEditable === 'true' && el.hasAttribute('data-field')) {
      var blockEl = el.closest('[data-block-id]');
      var blockId = blockEl ? blockEl.getAttribute('data-block-id') : null;
      postToParent({
        type: 'canvas:field-changed',
        blockId: blockId,
        fieldPath: el.getAttribute('data-field'),
        newValue: el.innerHTML,
      });
      el.contentEditable = 'false';
    }
  }, true);

  // Track block selection without entering edit mode (single click outside fields).
  document.addEventListener('mousedown', function (ev) {
    var el = ev.target;
    while (el && el.nodeType === 1) {
      if (el.hasAttribute && el.hasAttribute('data-block-id')) {
        postToParent({ type: 'canvas:block-selected', blockId: el.getAttribute('data-block-id') });
        return;
      }
      el = el.parentNode;
    }
  });

  // Notify parent the canvas is ready.
  postToParent({ type: 'canvas:ready' });
})();
</script>`;
