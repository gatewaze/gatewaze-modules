/**
 * BroadcastContentEditor — the broadcast Content tab's block editor.
 * Per spec-broadcasts-blocks.md §4.3.
 *
 * Reuses the newsletters Puck canvas (palette + drag/drop + live email
 * preview) verbatim, driven by broadcast data instead of a newsletter edition:
 *   - builds a NewsletterEdition from broadcast_blocks,
 *   - mounts NewsletterCanvasEditor with an EMPTY blockTemplates list so the
 *     full email-blocks registry is offered as the palette (no library seed),
 *   - hides the newsletter-specific toolbar actions and supplies broadcast
 *     Save / Send buttons instead (Send saves then advances to the Sending step),
 *   - on save, persists the edited blocks back to broadcast_blocks, renders the
 *     body via the same exportEditionHtml path the newsletter send uses (so the
 *     canvas preview == the sent email), tags per-block ?nlb= links, and writes
 *     broadcasts.rendered_html.
 *
 * The editor fills the remaining viewport height (measured) with its panes
 * scrolling internally, so the page itself never scrolls.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui';
import { NewsletterCanvasEditor } from '../../../newsletters/admin/components/puck/NewsletterCanvasEditor';
import { exportEditionHtml } from '../../../newsletters/admin/components/puck/email-blocks/export-edition-html';
import { buildEmailRegistry } from '../../../newsletters/admin/components/puck/email-blocks/declarative/registry';
import type { BlockRenderMeta } from '../../../newsletters/admin/components/puck/email-blocks/EditionEmail';
import type { NewsletterEdition, EditionBlock } from '../../../newsletters/admin/utils/types';
import { tagHtmlLinks } from '../../lib/link-tracking.js';
import {
  ensureInitialBlock,
  listBlocks,
  saveBroadcastEditionBlocks,
  syncBroadcastLinks,
  saveRenderedHtml,
  type BroadcastBlock,
} from '../lib/broadcastBlockService.js';
import { getBroadcast, type Broadcast } from '../lib/broadcastService';

// The full email-blocks registry (no per-library declarative blocks → the
// static registry, offering every core block as the palette).
const registry = buildEmailRegistry([], []);

// STABLE references — these feed the canvas's `config` useMemo. If we passed
// fresh `[]` literals, the config would rebuild every render (i.e. every
// keystroke via onChange), remounting every block and dropping inline-editor
// focus after one character. Same fix the newsletters page documents.
const EMPTY_BLOCK_TEMPLATES: never[] = [];
const EMPTY_BRICK_TEMPLATES: never[] = [];

// Blocks NOT offered in the broadcast palette. weather / local_events /
// virtual_events ARE offered — the broadcast send path now resolves them per
// recipient (token→HTML-or-empty), same as newsletters (spec-broadcasts-blocks
// §11.4). We still drop AI, newsletter-editorial, and e-commerce blocks that
// don't apply to broadcasts.
const BROADCAST_BLOCK_DENYLIST = new Set<string>([
  // AI / gatewaze-internal:
  'ai_summary', 'ai_section', 'agent_infrastructure',
  // Newsletter-editorial (MLOps template specifics):
  'hot_take', 'job_of_week', 'podcast', 'ml_confessions', 'mlops_community',
  'meme_of_week', 'hidden_gems', 'last_weeks_take', 'reading_group',
  'how_we_help', 'sponsored_ad', 'email_only_intro', 'intro_paragraph',
  // E-commerce:
  'cart_summary', 'order_receipt', 'shipping_tracker', 'product_card',
  'product_grid', 'pricing_card', 'pricing_comparison',
]);
// Stable (module-level) so it doesn't churn the canvas config per render.
const BROADCAST_BLOCK_IDS: string[] = [...registry.keys()].filter((id) => !BROADCAST_BLOCK_DENYLIST.has(id));

/** broadcast_blocks row → the canvas's EditionBlock shape. */
function toEditionBlock(b: BroadcastBlock): EditionBlock {
  return {
    id: b.id,
    block_template: {
      id: b.templates_block_def_id ?? '',
      name: b.block_type,
      block_type: b.block_type,
      render_kind: 'react-email',
      content: { html_template: '', rich_text_template: null, has_bricks: false, schema: {} },
    },
    content: (b.content ?? {}) as Record<string, unknown>,
    sort_order: b.sort_order,
    bricks: [],
  };
}

/** Build the render metadata map (mirror NewsletterPuckCanvas.buildBlockMeta). */
function buildBlockMeta(edition: NewsletterEdition): Map<string, BlockRenderMeta> {
  const meta = new Map<string, BlockRenderMeta>();
  for (const block of edition.blocks) {
    const tpl = block.block_template as typeof block.block_template & { render_kind?: string | null; component_id?: string | null };
    const componentId = tpl.component_id || tpl.block_type;
    const isReactish = registry.has(tpl.block_type) || tpl.render_kind === 'react-email' || tpl.render_kind === 'declarative';
    meta.set(
      block.id,
      isReactish
        ? { render_kind: 'react-email', component_id: componentId }
        : { render_kind: 'mustache', mustache_html: block.block_template.content.html_template ?? '' },
    );
  }
  return meta;
}

export function BroadcastContentEditor({ broadcast, editable, onSaved, onProceedToSending }: {
  broadcast: Broadcast;
  editable: boolean;
  onSaved: (b: Broadcast) => void;
  onProceedToSending: () => void;
}) {
  const [edition, setEdition] = useState<NewsletterEdition | null>(null);
  const [saving, setSaving] = useState(false);
  const editionDate = useMemo(
    () => (broadcast.created_at ? broadcast.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10)),
    [broadcast.created_at],
  );

  // Fill the remaining viewport height so the page itself never scrolls; the
  // canvas panes scroll internally. Measured (not a hard-coded calc) so it
  // adapts to the event-link card above. Mirrors editions/[id].tsx.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [editorHeight, setEditorHeight] = useState<number | null>(null);
  useEffect(() => {
    function measure() {
      const el = wrapperRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const viewportH = window.visualViewport?.height ?? window.innerHeight;
      const next = Math.max(320, Math.floor(viewportH - top - 24));
      setEditorHeight((cur) => (cur !== next ? next : cur));
    }
    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    const ro = new ResizeObserver(measure);
    if (wrapperRef.current) ro.observe(wrapperRef.current);
    return () => {
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      ro.disconnect();
    };
  }, [edition]);

  // Seed / load blocks on open, then build the edition the canvas edits.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const blocks = await ensureInitialBlock(broadcast.id, {
          content_json: broadcast.content_json,
          rendered_html: broadcast.rendered_html,
        });
        if (cancelled) return;
        setEdition({
          id: broadcast.id,
          edition_date: editionDate,
          subject: broadcast.subject ?? undefined,
          preheader: broadcast.preheader ?? undefined,
          blocks: blocks.map(toEditionBlock),
        });
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Failed to load content');
      }
    })();
    return () => { cancelled = true; };
  }, [broadcast.id, editionDate, broadcast.content_json, broadcast.rendered_html, broadcast.subject, broadcast.preheader]);

  /** Persist blocks + render + track. Returns the fresh broadcast (or null). */
  async function persist(): Promise<Broadcast | null> {
    if (!edition) return null;
    // 1. Persist the canvas blocks.
    await saveBroadcastEditionBlocks(broadcast.id, edition.blocks);
    // 2. Sync the per-block link registry from the persisted blocks.
    const persisted = await listBlocks(broadcast.id);
    const taggable = await syncBroadcastLinks(broadcast.id, persisted);
    // 3. Render the body via the same path the send uses (preview == send),
    //    then stamp ?nlb= onto the rendered links.
    const html = await exportEditionHtml({
      edition,
      format: 'email',
      blockMeta: buildBlockMeta(edition),
      wrapperTemplate: null,
      registry,
      forSend: true,
    });
    await saveRenderedHtml(broadcast.id, tagHtmlLinks(html, taggable));
    return getBroadcast(broadcast.id);
  }

  async function handleSave(advance: boolean) {
    if (!edition || saving) return;
    setSaving(true);
    try {
      const fresh = await persist();
      toast.success('Content saved');
      if (fresh) onSaved(fresh);
      if (advance) onProceedToSending();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save content');
    } finally {
      setSaving(false);
    }
  }

  const toolbarActions = editable ? (
    <>
      <Button variant="soft" onClick={() => handleSave(false)} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      <Button variant="solid" onClick={() => handleSave(true)} disabled={saving}>Send…</Button>
    </>
  ) : null;

  if (!edition) {
    return <p className="text-sm text-[var(--gray-10)]">Loading content…</p>;
  }

  return (
    <div
      ref={wrapperRef}
      style={{
        height: editorHeight != null ? `${editorHeight}px` : 'calc(100vh - 260px)',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      <NewsletterCanvasEditor
        edition={edition}
        blockTemplates={EMPTY_BLOCK_TEMPLATES}
        brickTemplates={EMPTY_BRICK_TEMPLATES}
        enabledRegistryComponentIds={BROADCAST_BLOCK_IDS}
        wrapperTemplate={null}
        collectionId={broadcast.id}
        isSaving={saving}
        onChange={setEdition}
        hideDefaultActions
        toolbarActions={toolbarActions}
      />
    </div>
  );
}

export default BroadcastContentEditor;
