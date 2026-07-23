/**
 * Broadcast body render — blocks → rendered_html.
 * Per spec-broadcasts-blocks.md §4.4.
 *
 * v1 renders the core `richtext` block (its `content.html` verbatim) wrapped in
 * a simple default shell. This is the zero-friction "just type" body and keeps
 * canvas == send trivially (the shell + the editor's own HTML). Blocks backed
 * by a git-managed def (content_section, video, event, …) render through the
 * newsletters `exportEditionHtml` path in a later step so their canvas preview
 * matches the sent email exactly — this pure module never renders those (it
 * skips them, empty-safe, and reports them) to avoid a divergent renderer.
 */

/** Structural subset of a broadcast_blocks row needed to render the body. */
export interface RenderableBlock {
  id: string;
  block_type: string;
  sort_order: number;
  content: Record<string, unknown>;
}

export interface RenderBroadcastResult {
  html: string;
  /** ids of blocks this pure renderer skipped (def-backed; need the react-email
   *  path). Empty in the richtext-only v1 case. */
  skipped: string[];
}

/**
 * Default broadcast shell: a single-column ~600px container. Intentionally
 * minimal — the send/drip path appends the unsubscribe/manage-preferences
 * footer when `{{unsubscribe_url}}` is absent (send-engine-binding), so the
 * shell doesn't hard-code one. `{{body}}` is the block slot; `{{preheader}}`
 * is the hidden inbox-preview line.
 */
export const DEFAULT_BROADCAST_SHELL = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;-webkit-text-size-adjust:none;text-size-adjust:none">
<div style="display:none;font-size:1px;color:#f4f4f5;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">{{preheader}}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:8px">
<tr><td style="padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#18181b">
{{body}}
</td></tr></table>
</td></tr></table>
</body></html>`;

/** HTML-escape a preheader for safe injection into the hidden preview span. */
function escapePreheader(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render a broadcast's blocks to the body HTML.
 *
 * @param blocks   ordered block instances
 * @param opts.shell  wrapper HTML with `{{body}}` (and optional `{{preheader}}`)
 *                    slots; omit to return the bare concatenated body.
 * @param opts.preheader  inbox-preview text for the shell.
 */
export function renderBroadcastBody(
  blocks: ReadonlyArray<RenderableBlock>,
  opts: { shell?: string | null; preheader?: string | null } = {},
): RenderBroadcastResult {
  const ordered = [...blocks].sort((a, b) => a.sort_order - b.sort_order);
  const parts: string[] = [];
  const skipped: string[] = [];

  for (const b of ordered) {
    if (b.block_type === 'richtext') {
      const html = typeof b.content?.html === 'string' ? (b.content.html as string) : '';
      if (html) parts.push(html);
      continue;
    }
    // Def-backed block: not rendered by this pure module (needs the
    // canvas-fidelity react-email path). Skip empty-safe; caller decides.
    skipped.push(b.id);
  }

  const body = parts.join('\n');
  const shell = opts.shell;
  if (!shell) return { html: body, skipped };

  const html = shell
    .replace('{{body}}', body)
    .replace('{{preheader}}', escapePreheader(opts.preheader ?? ''));
  return { html, skipped };
}
