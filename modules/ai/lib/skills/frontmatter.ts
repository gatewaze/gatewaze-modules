/**
 * Skill frontmatter parser.
 *
 * Per spec-ai-skills.md §6: skill files are markdown with optional YAML
 * frontmatter. Required field is `name`; everything else is optional and
 * falls back to synthesised values.
 *
 * Uses gray-matter (which wraps js-yaml). Errors during parse don't
 * throw — they return a result with `ok: false` so the sync worker can
 * log + skip rather than crashing the whole sync.
 */

import matter from 'gray-matter';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export interface ParsedSkill {
  name: string;
  description: string | null;
  tags: string[];
  applies_to: string[];
  body: string;
  body_chars: number;
  content_hash: string;
  /**
   * First entry of frontmatter `reference_images: [path]`, validated as
   * a safe relative path. Null when absent. Today we accept at most one
   * reference image per skill — additional entries are dropped with a
   * warning. The sync worker resolves this path relative to the .md
   * file location, reads the bytes from disk, and stores them on the
   * ai_skills row (migration 006_ai_skills_reference_image).
   */
  reference_image_path: string | null;
}

export type ParseResult =
  | { ok: true; skill: ParsedSkill }
  | { ok: false; reason: string };

const VALID_APPLIES_TO = new Set(['newsletter', 'site']);

export function parseSkillFile(filePath: string, raw: string): ParseResult {
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `frontmatter_parse_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const data = parsed.data as Record<string, unknown>;
  const body = parsed.content.trim();

  // Name — required from frontmatter, falls back to file basename.
  let name: string;
  if (typeof data.name === 'string' && data.name.trim().length > 0) {
    name = data.name.trim().slice(0, 200);
  } else {
    const base = basename(filePath, '.md');
    name = base.length > 0 ? base : 'Untitled skill';
  }

  // Description — optional, falls back to first paragraph of body.
  let description: string | null = null;
  if (typeof data.description === 'string' && data.description.trim().length > 0) {
    description = data.description.trim().slice(0, 300);
  } else {
    // First non-empty paragraph (lines separated by a blank line),
    // capped to 200 chars. Markdown heading lines (`# …`) and HR
    // (`---`) are stripped from the first paragraph candidate.
    const firstParaRaw = body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)[0];
    if (firstParaRaw) {
      const cleaned = firstParaRaw
        .replace(/^#{1,6}\s+/, '') // strip leading "## "
        .replace(/^\s*[-*_]{3,}\s*$/m, '') // strip HR lines
        .trim()
        .slice(0, 200);
      description = cleaned.length > 0 ? cleaned : null;
    }
  }

  // Tags — accept array of strings, otherwise empty.
  const tags = Array.isArray(data.tags)
    ? (data.tags as unknown[])
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t.length <= 64)
        .slice(0, 32)
    : [];

  // applies_to — accept array of strings, restrict to known values.
  const appliesToRaw = Array.isArray(data.applies_to) ? data.applies_to : [];
  const applies_to = (appliesToRaw as unknown[])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => VALID_APPLIES_TO.has(t));

  // reference_images — accept an array of relative paths. Today we
  // only consume the first valid entry (one ref image per skill).
  // Safe-path rules: must be relative, no leading `/`, no `..`
  // segments, no whitespace, no `\` (Windows-style).
  let reference_image_path: string | null = null;
  const refRaw = Array.isArray(data.reference_images) ? data.reference_images : [];
  for (const candidate of refRaw as unknown[]) {
    if (typeof candidate !== 'string') continue;
    const p = candidate.trim();
    if (p.length === 0) continue;
    if (!isReferencePathSafe(p)) continue;
    reference_image_path = p;
    break;
  }

  return {
    ok: true,
    skill: {
      name,
      description,
      tags,
      applies_to,
      body,
      body_chars: body.length,
      content_hash: hashBody(body),
      reference_image_path,
    },
  };
}

function isReferencePathSafe(p: string): boolean {
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  if (/\s/.test(p)) return false;
  if (p.split('/').some((seg) => seg === '..' || seg === '')) return false;
  return /^[A-Za-z0-9_./-]+$/.test(p);
}

function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf-8').digest('hex');
}
