/**
 * A preview of how Slack shows a message, for the Slack broadcast editor.
 *
 * Covers the mrkdwn people actually type: *bold*, _italic_, ~strike~,
 * `code`, ```code blocks```, > quotes, <url|label> links and bare URLs.
 * The output is plain data that the editor renders as React elements, so a
 * message can never inject markup into the admin page.
 */

export type InlinePart =
  | { kind: 'text'; text: string }
  | { kind: 'bold' | 'italic' | 'strike' | 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

export type PreviewBlock =
  | { kind: 'line'; parts: InlinePart[] }
  | { kind: 'quote'; parts: InlinePart[] }
  | { kind: 'code'; text: string };

const INLINE = /`([^`\n]+)`|<(https?:\/\/[^|>\s]+)(?:\|([^>\n]+))?>|\*([^*\n]+)\*|_([^_\n]+)_|~([^~\n]+)~|(https?:\/\/[^\s<>]+)/g;

/** Only http(s) links are shown as links; anything else stays text. */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

/** Slack shows &amp; &lt; &gt; as the characters. */
function unescapeSlack(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function parseInline(line: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ kind: 'text', text: unescapeSlack(line.slice(last, at)) });
    if (m[1] !== undefined) parts.push({ kind: 'code', text: m[1] });
    else if (m[2] !== undefined) {
      const href = safeHref(m[2]);
      parts.push(href ? { kind: 'link', href, text: unescapeSlack(m[3] ?? m[2]) } : { kind: 'text', text: m[0] });
    } else if (m[4] !== undefined) parts.push({ kind: 'bold', text: unescapeSlack(m[4]) });
    else if (m[5] !== undefined) parts.push({ kind: 'italic', text: unescapeSlack(m[5]) });
    else if (m[6] !== undefined) parts.push({ kind: 'strike', text: unescapeSlack(m[6]) });
    else if (m[7] !== undefined) {
      const href = safeHref(m[7]);
      parts.push(href ? { kind: 'link', href, text: m[7] } : { kind: 'text', text: m[7] });
    }
    last = at + m[0].length;
  }
  if (last < line.length) parts.push({ kind: 'text', text: unescapeSlack(line.slice(last)) });
  return parts;
}

export function parseSlackMessage(text: string): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      const body: string[] = [];
      const first = line.trimStart().slice(3);
      // A one-line block: ```code```
      if (first.endsWith('```') && first.length >= 3) { blocks.push({ kind: 'code', text: first.slice(0, -3) }); continue; }
      if (first) body.push(first);
      let j = i + 1;
      for (; j < lines.length && !lines[j].includes('```'); j++) body.push(lines[j]);
      if (j < lines.length) { const tail = lines[j].slice(0, lines[j].indexOf('```')); if (tail) body.push(tail); }
      blocks.push({ kind: 'code', text: body.join('\n') });
      i = j;
      continue;
    }
    if (/^(>|&gt;)\s?/.test(line)) { blocks.push({ kind: 'quote', parts: parseInline(line.replace(/^(>|&gt;)\s?/, '')) }); continue; }
    blocks.push({ kind: 'line', parts: parseInline(line) });
  }
  return blocks;
}

/** Sample values for merge fields in the preview. */
export const SAMPLE_MERGE_VALUES: Record<string, string> = {
  first_name: 'Alex', last_name: 'Rivera', name: 'Alex Rivera', company: 'Acme', job_title: 'ML engineer',
};

/** Fill {{merge_fields}} with sample values; a {{field|"fallback"}} keeps its field's sample. */
export function fillSampleValues(text: string): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*(?:\|[^}]*)?\}\}/g, (whole, key: string) => SAMPLE_MERGE_VALUES[key] ?? whole);
}
