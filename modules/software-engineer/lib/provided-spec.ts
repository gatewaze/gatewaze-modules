// @ts-nocheck
/**
 * Locally-authored spec handoff — parsing + extraction for the `agent:spec:provided` /
 * `agent:spec:approved` issue labels.
 *
 * A human (or an outer agent) writes the spec locally, puts it in the issue body, and labels the
 * issue. Intake stores the extracted text as the run's `kind='spec'` artifact — the exact shape the
 * spec phase would have produced — so review/refine/implement downstream are none the wiser. The
 * spec and spec-self-review phases are skipped entirely (never billed).
 *
 * Body format (both documented; markers win when present):
 *   1. Marker fence — everything between `<!-- se:spec -->` and `<!-- /se:spec -->`. Preferred:
 *      unambiguous, and survives issue templates that already use `## Spec`-like headings.
 *   2. Heading — everything under a `## Spec` heading, up to the next h1/h2 heading or EOF.
 *
 * Trust model (mirrors model-select.ts's parseOverrideLabels): labels are repo-collaborator input.
 * That is acceptable for this module's conventions, but the extracted text is CONTENT only — it is
 * stored as an artifact and rendered through the admin's escaping Markdown renderer; it is never
 * parsed as config, labels, routing, or commands. Extraction fails loud (never silently proceeds)
 * on a missing/empty section, an unclosed marker, or an oversize body section.
 */

export const SPEC_PROVIDED_LABEL = 'agent:spec:provided';
export const SPEC_APPROVED_LABEL = 'agent:spec:approved';

/** Size cap for a provided spec (bytes of UTF-8). Far above any sane spec, far below anything that
 *  could bloat artifact storage or downstream prompts (implement truncates at 20k chars anyway). */
export const MAX_PROVIDED_SPEC_BYTES = 64 * 1024;

const OPEN_MARKER = /<!--\s*se:spec\s*-->/i;
const CLOSE_MARKER = /<!--\s*\/se:spec\s*-->/i;
// `## Spec` on its own line (optional trailing colon/whitespace), case-insensitive.
const SPEC_HEADING = /^##\s+spec\s*:?\s*$/i;
// A same-or-higher-level heading (h1/h2) terminates the heading-mode section. `###…` does not.
const SECTION_END = /^##?\s+\S/;

export interface SpecLabels { provided: boolean; approved: boolean }

/** Which spec-handoff labels an issue carries. Matching is exact (after trim + lowercase) — a
 *  namespaced or suffixed label is NOT a spec label. */
export function parseSpecLabels(labels: string[]): SpecLabels {
  const set = new Set((labels ?? []).map((l) => String(l ?? '').trim().toLowerCase()));
  return { provided: set.has(SPEC_PROVIDED_LABEL), approved: set.has(SPEC_APPROVED_LABEL) };
}

export type ProvidedSpecResult =
  | { spec: string; source: 'markers' | 'heading' }
  | { error: string };

function finalize(raw: string, source: 'markers' | 'heading'): ProvidedSpecResult {
  // Content-only sanitation: normalize newlines and strip NUL bytes (Postgres `text` rejects them).
  // Nothing else is rewritten — the spec is data, and the admin renders it through the escaping
  // Markdown renderer (no rehype-raw), so raw HTML/script in it never reaches the DOM unescaped.
  const spec = String(raw).replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
  if (!spec) return { error: 'the spec section is empty' };
  if (Buffer.byteLength(spec, 'utf8') > MAX_PROVIDED_SPEC_BYTES) {
    return { error: `the provided spec exceeds the ${Math.floor(MAX_PROVIDED_SPEC_BYTES / 1024)}KB cap` };
  }
  return { spec, source };
}

/**
 * Extract the provided spec from an issue body. Markers are preferred when the opening marker is
 * present — including when it is malformed (an unclosed marker is an error, not a silent fallback
 * to heading mode, because the author clearly intended marker mode). Returns `{ error }` rather
 * than throwing so intake can fail the run with the message verbatim.
 */
export function extractProvidedSpec(body: unknown): ProvidedSpecResult {
  const text = typeof body === 'string' ? body : '';
  const open = OPEN_MARKER.exec(text);
  if (open) {
    const rest = text.slice(open.index + open[0].length);
    const close = CLOSE_MARKER.exec(rest);
    if (!close) return { error: 'found an opening <!-- se:spec --> marker without a closing <!-- /se:spec --> marker' };
    return finalize(rest.slice(0, close.index), 'markers');
  }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => SPEC_HEADING.test(l.trim()));
  if (start === -1) {
    return { error: 'no spec section found in the issue body — add a "## Spec" heading, or fence the spec between <!-- se:spec --> and <!-- /se:spec --> markers' };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (SECTION_END.test(lines[i])) { end = i; break; }
  }
  return finalize(lines.slice(start + 1, end).join('\n'), 'heading');
}
