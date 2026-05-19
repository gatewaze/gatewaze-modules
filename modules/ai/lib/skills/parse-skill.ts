/**
 * Skill parser — agentskills.io conformant, per spec-ai-workflows-and-
 * skill-interop.md §4.1.
 *
 * A skill is a DIRECTORY containing SKILL.md. The directory basename
 * IS the skill name. Frontmatter requires `name` and `description`;
 * `metadata` is a flat string→string map; everything else is Tier-2
 * (silently accepted, persisted as metadata, may or may not be
 * honoured at runtime depending on §4.3) or Tier-3 (refused with a
 * structured `unsupported_features` payload).
 *
 * v1 deliberately refuses Tier-3 features — `!`<...>`` shell injection,
 * `$ARGUMENTS` substitution, `${CLAUDE_*}` / `${GOOSE_*}` env vars,
 * and the `arguments:` frontmatter field. The expectation is that
 * authors writing portable skills don't use these; authors who need
 * them are using a different runtime (Claude Code CLI) which we don't
 * try to emulate.
 *
 * Resource files (siblings of SKILL.md under `references/`, `scripts/`,
 * `assets/`, or root) are recorded as inert metadata in v1 — paths
 * only, never loaded at runtime. See §3.2.
 */

import matter from 'gray-matter';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

/**
 * Public output of the parser. Discriminated union per the spec — the
 * sync worker branches on `ok` first, then on `reason` to decide
 * whether the skill is rejected (`refused` — Tier-3 features) or
 * malformed (`parse_error` — missing required field, dir-name
 * mismatch, etc.).
 */
export type ParseSkillResult =
  | { ok: true; skill: ParsedSkill; warnings: string[] }
  | { ok: false; reason: 'refused'; refusal: UnsupportedFeature[] }
  | { ok: false; reason: 'parse_error'; message: string };

export interface ParsedSkill {
  /** Canonical identifier; equals `basename(skillDirPath)` per spec. */
  name: string;
  /** Required, ≤1024 chars. */
  description: string;
  /** Flat string→string map. Non-string values are refused at parse time. */
  metadata: Record<string, string>;
  /** Sibling-file relative paths. Inert in v1; admin-display only. */
  resources: string[];
  /** Markdown body (post-frontmatter, trimmed). */
  body: string;
  body_chars: number;
  content_hash: string;
}

export interface UnsupportedFeature {
  feature:
    | 'shell-injection'
    | 'argument-substitution'
    | 'env-substitution'
    | 'arguments-field';
  /** Location is best-effort; 1-indexed line/col into the raw file. */
  location: { line: number; col: number; snippet: string };
}

/**
 * Frontmatter name regex per agentskills.io: lowercase letters,
 * digits, and hyphens; must start with a letter; no consecutive,
 * leading, or trailing hyphens; ≤64 chars.
 */
const NAME_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const DESCRIPTION_MAX = 1024;
const LICENSE_MAX = 500;
const COMPATIBILITY_MAX = 500;
const WHEN_TO_USE_MAX = 1024;

/**
 * Claude Code interactive-CLI frontmatter fields. Persisted to
 * metadata for visibility but unused at runtime. See §4.1's Tier-2
 * paragraph "All Claude Code interactive-CLI fields ignored entirely".
 */
const CLI_INTERACTIVE_FIELDS = new Set([
  'disable-model-invocation',
  'user-invocable',
  'argument-hint',
  'model',
  'effort',
  'context',
  'agent',
  'hooks',
  'shell',
]);

/**
 * Parse a single SKILL.md file. The caller (sync worker) supplies the
 * directory path so we can enforce the `name == basename(dir)` invariant.
 */
export function parseSkill(
  skillDirPath: string,
  skillMdRaw: string,
  siblingFiles: string[],
): ParseSkillResult {
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(skillMdRaw);
  } catch (err) {
    return {
      ok: false,
      reason: 'parse_error',
      message: `frontmatter_parse_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const data = parsed.data as Record<string, unknown>;
  const body = parsed.content.trim();

  // ── Tier-3 refusal checks (frontmatter side) ─────────────────────
  // The `arguments` field signals positional-arg binding which v1
  // doesn't support. Refusing here keeps the contract clean: rather
  // than silently dropping an author's expected behaviour, we surface
  // it loudly.
  const refusals: UnsupportedFeature[] = [];
  if (data.arguments !== undefined) {
    refusals.push({
      feature: 'arguments-field',
      location: { line: 1, col: 1, snippet: 'arguments:' },
    });
  }

  // ── Tier-3 refusal checks (body side) ────────────────────────────
  // Body substitution primitives are looked up via regex. We scan the
  // *raw* body (pre-trim) so line numbers in the snippet location are
  // accurate against the file's original layout.
  const rawBody = parsed.content;
  collectBodyRefusals(rawBody, refusals);
  if (refusals.length > 0) {
    return { ok: false, reason: 'refused', refusal: refusals };
  }

  // ── Required: `name` ─────────────────────────────────────────────
  const dirBase = basename(skillDirPath);
  if (typeof data.name !== 'string') {
    return { ok: false, reason: 'parse_error', message: 'frontmatter.name required (string)' };
  }
  const name = data.name.trim();
  if (name.length === 0 || name.length > 64) {
    return { ok: false, reason: 'parse_error', message: 'frontmatter.name must be 1–64 chars' };
  }
  if (!NAME_REGEX.test(name)) {
    return {
      ok: false,
      reason: 'parse_error',
      message: `frontmatter.name '${name}' must match ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ (lowercase, hyphen-separated, no leading/trailing/consecutive hyphens)`,
    };
  }
  if (name !== dirBase) {
    return {
      ok: false,
      reason: 'parse_error',
      message: `frontmatter.name '${name}' must equal directory basename '${dirBase}' (agentskills.io invariant)`,
    };
  }

  // ── Required: `description` ──────────────────────────────────────
  if (typeof data.description !== 'string') {
    return { ok: false, reason: 'parse_error', message: 'frontmatter.description required (string)' };
  }
  const description = data.description.trim();
  if (description.length === 0) {
    return { ok: false, reason: 'parse_error', message: 'frontmatter.description must not be empty' };
  }
  if (description.length > DESCRIPTION_MAX) {
    return {
      ok: false,
      reason: 'parse_error',
      message: `frontmatter.description exceeds ${DESCRIPTION_MAX} chars (got ${description.length})`,
    };
  }

  // ── Required: non-empty body ─────────────────────────────────────
  if (body.length === 0) {
    return { ok: false, reason: 'parse_error', message: 'SKILL.md body is empty after frontmatter' };
  }

  // ── metadata (flat string→string) ────────────────────────────────
  // The agentskills.io spec is unambiguous here. Non-string values
  // refuse at parse time — authors can JSON-encode richer types.
  const metadata: Record<string, string> = {};
  if (data.metadata !== undefined) {
    if (typeof data.metadata !== 'object' || data.metadata === null || Array.isArray(data.metadata)) {
      return {
        ok: false,
        reason: 'parse_error',
        message: 'frontmatter.metadata must be a flat object (Record<string,string>)',
      };
    }
    for (const [k, v] of Object.entries(data.metadata as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        return {
          ok: false,
          reason: 'parse_error',
          message: `frontmatter.metadata.${k} must be a string (got ${typeof v}); JSON-encode richer types`,
        };
      }
      metadata[k] = v;
    }
  }

  // ── Tier-2 fields — persist into metadata for visibility ─────────
  // Unmapped Tier-2 fields are dropped into metadata as escape hatch
  // so the operator UI can show "this skill declared X" without us
  // pretending to honour it.
  const warnings: string[] = [];

  // license / compatibility — straight passthroughs with length cap.
  if (typeof data.license === 'string' && data.license.trim().length > 0) {
    metadata.license = data.license.trim().slice(0, LICENSE_MAX);
  }
  if (typeof data.compatibility === 'string' && data.compatibility.trim().length > 0) {
    metadata.compatibility = data.compatibility.trim().slice(0, COMPATIBILITY_MAX);
  }
  if (typeof data.when_to_use === 'string' && data.when_to_use.trim().length > 0) {
    metadata.when_to_use = data.when_to_use.trim().slice(0, WHEN_TO_USE_MAX);
  }

  // allowed-tools — accept string or string[]; emit a parse_warning
  // per non-Gatewaze tool so the operator can see what's declared but
  // won't be available at runtime.
  const allowedTools = normaliseStringOrArray(data['allowed-tools'] ?? data.allowed_tools);
  if (allowedTools.length > 0) {
    metadata['allowed-tools'] = allowedTools.join(',');
    const supported = new Set(['web_search', 'fetch_url', 'gatewaze_search']);
    for (const tool of allowedTools) {
      if (!supported.has(tool)) {
        warnings.push(`allowed_tools_unsupported: ${tool}`);
      }
    }
  }

  // paths — persisted but inert. The spec is explicit ("Completely
  // inert at runtime in v1 — used only for future host-kind filtering
  // and admin-UI display").
  const paths = normaliseStringOrArray(data.paths);
  if (paths.length > 0) {
    metadata.paths = paths.join(',');
  }

  // CLI-interactive fields — drop into metadata, no warning (they're
  // not portability errors, just unused).
  for (const [k, v] of Object.entries(data)) {
    if (!CLI_INTERACTIVE_FIELDS.has(k)) continue;
    if (typeof v === 'string') metadata[k] = v;
    else metadata[k] = JSON.stringify(v);
  }

  // ── Resources ────────────────────────────────────────────────────
  // Recorded for forward-compat / admin display only. Filter out the
  // SKILL.md itself; record everything else relative to the directory.
  const resources = siblingFiles
    .filter((f) => f !== 'SKILL.md' && f.length > 0)
    .sort();

  return {
    ok: true,
    skill: {
      name,
      description,
      metadata,
      resources,
      body,
      body_chars: body.length,
      content_hash: createHash('sha256').update(body, 'utf-8').digest('hex'),
    },
    warnings,
  };
}

// ── Internal helpers ─────────────────────────────────────────────────

function normaliseStringOrArray(v: unknown): string[] {
  if (typeof v === 'string') {
    return v.trim().length > 0 ? [v.trim()] : [];
  }
  if (Array.isArray(v)) {
    return v
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  }
  return [];
}

/**
 * Scan the SKILL.md body for Tier-3 substitution primitives and
 * record each occurrence into `refusals`. We intentionally over-match
 * (e.g. ``!`...`` inside fenced code blocks is still flagged) so that
 * skill authors can't sneak through a Tier-3 feature by hiding it in
 * a code fence. The cost is occasional false-positives on documentation
 * skills that describe these features — the workaround is to rephrase.
 *
 * Patterns scanned (per spec §4.1 Tier-3 bullet):
 *   ! `<...>`        — shell-output injection
 *   ```! ...```      — fenced shell block
 *   $ARGUMENTS, $N   — positional argument substitution
 *   $<name>          — named-argument substitution
 *   ${CLAUDE_*}      — Claude Code env substitution
 *   ${GOOSE_*}       — Goose env substitution
 */
function collectBodyRefusals(rawBody: string, refusals: UnsupportedFeature[]): void {
  const patterns: Array<{
    feature: UnsupportedFeature['feature'];
    regex: RegExp;
  }> = [
    { feature: 'shell-injection',        regex: /!`[^`]+`/g },
    { feature: 'shell-injection',        regex: /```!\s/g },
    { feature: 'argument-substitution',  regex: /\$ARGUMENTS\b/g },
    { feature: 'argument-substitution',  regex: /\$\d+\b/g },
    { feature: 'argument-substitution',  regex: /\$<[a-zA-Z_][a-zA-Z0-9_]*>/g },
    { feature: 'env-substitution',       regex: /\$\{(?:CLAUDE|GOOSE)_[A-Z0-9_]+\}/g },
  ];

  for (const { feature, regex } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(rawBody)) !== null) {
      const loc = lineColOf(rawBody, match.index);
      refusals.push({
        feature,
        location: {
          line: loc.line,
          col: loc.col,
          snippet: rawBody.slice(match.index, Math.min(match.index + 80, rawBody.length)),
        },
      });
    }
  }
}

function lineColOf(text: string, index: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}
