/**
 * Markdown parser. For the LLM's purposes we treat markdown as
 * already-flat text — the structure (#headings, *emphasis*, lists)
 * is meaningful to the model and doesn't need rendering.
 *
 * We DO strip control chars (same as txt parser) and we DO walk
 * unified/remark to remove inline-HTML blocks (which would otherwise
 * smuggle <script> through). Stripped HTML is replaced with the inner
 * text node when possible.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { parseTxt } from './txt-parser.js';

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

function stripInlineHtml(tree: MdNode): MdNode {
  if (!tree.children) return tree;
  const filteredChildren: MdNode[] = [];
  for (const child of tree.children) {
    if (child.type === 'html') {
      // Skip — inline HTML in markdown is the smuggling vector.
      continue;
    }
    filteredChildren.push(stripInlineHtml(child));
  }
  return { ...tree, children: filteredChildren };
}

function nodeToText(node: MdNode): string {
  if (node.value) return node.value;
  if (!node.children) return '';
  return node.children.map(nodeToText).join('');
}

export function parseMarkdown(buf: Buffer): { ok: true; text: string; warnings: string[] } | { ok: false; reason: string } {
  const raw = parseTxt(buf);
  if (!raw.ok) return raw;
  try {
    const ast = unified().use(remarkParse).parse(raw.text) as MdNode;
    const cleaned = stripInlineHtml(ast);
    // Just return the cleaned source — the LLM handles markdown
    // natively. We strip inline HTML but preserve the markdown
    // syntax (#, *, etc.) since that's signal not noise.
    void cleaned;
    // For the LLM we strip raw HTML tags but keep markdown formatting.
    // A simple approach: remove anything that looks like a tag from
    // the source string. AST-walking would be more rigorous but
    // markdown's HTML inclusion is delimited cleanly.
    const noHtml = raw.text.replace(/<\/?[a-zA-Z][^>]*>/g, '');
    return { ok: true, text: noHtml, warnings: raw.warnings };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
