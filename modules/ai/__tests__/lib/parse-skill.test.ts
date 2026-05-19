/**
 * parseSkill — agentskills.io conformance tests.
 *
 * Mirrors spec-ai-workflows-and-skill-interop.md §4.1: every Tier-3
 * primitive must be refused; every Tier-2 field is silently persisted
 * to metadata; required fields and the basename invariant are
 * enforced; resources come from the sibling-file listing.
 */

import { describe, expect, it } from 'vitest';
import { parseSkill } from '../../lib/skills/parse-skill.js';

const dir = '/repo/skills/sample-skill';

function md(frontmatter: string, body = 'Body text.'): string {
  return `---\n${frontmatter}\n---\n${body}\n`;
}

describe('parseSkill — happy path', () => {
  it('returns ok with name, description, body, content_hash', () => {
    const raw = md('name: sample-skill\ndescription: A sample skill.', 'Hello world.');
    const r = parseSkill(dir, raw, ['SKILL.md', 'references/a.md']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.name).toBe('sample-skill');
    expect(r.skill.description).toBe('A sample skill.');
    expect(r.skill.body).toBe('Hello world.');
    expect(r.skill.body_chars).toBe('Hello world.'.length);
    expect(r.skill.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.skill.resources).toEqual(['references/a.md']);
    expect(r.warnings).toEqual([]);
  });

  it('records all sibling files except SKILL.md, sorted', () => {
    const raw = md('name: sample-skill\ndescription: x');
    const r = parseSkill(dir, raw, ['scripts/run.sh', 'SKILL.md', 'assets/logo.png', 'references/notes.md']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.resources).toEqual([
      'assets/logo.png',
      'references/notes.md',
      'scripts/run.sh',
    ]);
  });

  it('emits identical content_hash for identical body, different metadata', () => {
    const a = parseSkill(dir, md('name: sample-skill\ndescription: one', 'BODY'), ['SKILL.md']);
    const b = parseSkill(dir, md('name: sample-skill\ndescription: two', 'BODY'), ['SKILL.md']);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.skill.content_hash).toBe(b.skill.content_hash);
  });
});

describe('parseSkill — required-field validation', () => {
  it('refuses missing name', () => {
    const r = parseSkill(dir, md('description: x'), ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('parse_error');
    if (r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/name required/);
  });

  it('refuses missing description', () => {
    const r = parseSkill(dir, md('name: sample-skill'), ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/description required/);
  });

  it('refuses empty description', () => {
    const r = parseSkill(dir, md('name: sample-skill\ndescription: ""'), ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/description must not be empty/);
  });

  it('refuses description > 1024 chars', () => {
    const desc = 'a'.repeat(1025);
    const r = parseSkill(dir, md(`name: sample-skill\ndescription: ${desc}`), ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/exceeds 1024 chars/);
  });

  it('refuses empty body', () => {
    const r = parseSkill(dir, '---\nname: sample-skill\ndescription: x\n---\n', ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/body is empty/);
  });
});

describe('parseSkill — name regex + basename invariant', () => {
  it.each([
    ['UPPER', 'sample-skill'],
    ['-leading', 'sample-skill'],
    ['trailing-', 'sample-skill'],
    ['double--hyphen', 'sample-skill'],
    ['1starts-with-digit', 'sample-skill'],
    ['has_underscore', 'sample-skill'],
    ['has.dot', 'sample-skill'],
  ])('refuses invalid name %s', (badName) => {
    const r = parseSkill(`/repo/skills/${badName}`, md(`name: ${badName}\ndescription: x`), ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/(must match|1.64 chars)/);
  });

  it.each(['a', 'ab', 'a-b', 'foo-bar-baz', 'foo123', 'a1-b2'])(
    'accepts valid name %s',
    (goodName) => {
      const r = parseSkill(
        `/repo/skills/${goodName}`,
        md(`name: ${goodName}\ndescription: x`),
        ['SKILL.md'],
      );
      expect(r.ok).toBe(true);
    },
  );

  it('refuses name longer than 64 chars', () => {
    const longName = 'a' + '-b'.repeat(40);
    const r = parseSkill(
      `/repo/skills/${longName}`,
      md(`name: ${longName}\ndescription: x`),
      ['SKILL.md'],
    );
    expect(r.ok).toBe(false);
  });

  it('refuses when name differs from directory basename', () => {
    const r = parseSkill('/repo/skills/the-dir', md('name: other-name\ndescription: x'), ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/must equal directory basename/);
  });
});

describe('parseSkill — Tier-3 refusals', () => {
  it('refuses arguments: frontmatter field', () => {
    const raw = '---\nname: sample-skill\ndescription: x\narguments: foo\n---\nBody.\n';
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'refused') return;
    expect(r.refusal.some((f) => f.feature === 'arguments-field')).toBe(true);
  });

  it('refuses inline shell injection !`cmd`', () => {
    const raw = md('name: sample-skill\ndescription: x', 'Run !`ls -la` to see files.');
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'refused') return;
    expect(r.refusal.some((f) => f.feature === 'shell-injection')).toBe(true);
  });

  it('refuses fenced shell block ```! ...```', () => {
    const raw = md('name: sample-skill\ndescription: x', '```! \necho hi\n```');
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'refused') return;
    expect(r.refusal.some((f) => f.feature === 'shell-injection')).toBe(true);
  });

  it('refuses $ARGUMENTS substitution', () => {
    const raw = md('name: sample-skill\ndescription: x', 'Use $ARGUMENTS here.');
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'refused') return;
    expect(r.refusal.some((f) => f.feature === 'argument-substitution')).toBe(true);
  });

  it('refuses positional $N substitution', () => {
    const raw = md('name: sample-skill\ndescription: x', 'first=$1 second=$2');
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'refused') return;
    expect(r.refusal.some((f) => f.feature === 'argument-substitution')).toBe(true);
  });

  it('refuses named $<name> substitution', () => {
    const raw = md('name: sample-skill\ndescription: x', 'Hello $<user_name>.');
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'refused') return;
    expect(r.refusal.some((f) => f.feature === 'argument-substitution')).toBe(true);
  });

  it('refuses ${CLAUDE_*} env substitution', () => {
    const raw = md('name: sample-skill\ndescription: x', 'cwd=${CLAUDE_PROJECT_DIR}');
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'refused') return;
    expect(r.refusal.some((f) => f.feature === 'env-substitution')).toBe(true);
  });

  it('refuses ${GOOSE_*} env substitution', () => {
    const raw = md('name: sample-skill\ndescription: x', 'model=${GOOSE_PROVIDER}');
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'refused') return;
    expect(r.refusal.some((f) => f.feature === 'env-substitution')).toBe(true);
  });

  it('collects multiple refusals in a single pass', () => {
    const raw = md(
      'name: sample-skill\ndescription: x',
      'shell=!`echo` and arg=$ARGUMENTS and env=${CLAUDE_FOO}',
    );
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'refused') return;
    const features = new Set(r.refusal.map((f) => f.feature));
    expect(features.has('shell-injection')).toBe(true);
    expect(features.has('argument-substitution')).toBe(true);
    expect(features.has('env-substitution')).toBe(true);
  });

  it('reports 1-indexed line/col for each refusal', () => {
    const raw = md('name: sample-skill\ndescription: x', 'line1\nline2 with $ARGUMENTS\n');
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'refused') return;
    const sub = r.refusal.find((f) => f.feature === 'argument-substitution');
    expect(sub).toBeDefined();
    // gray-matter strips frontmatter, so body starts at line 1 internally.
    expect(sub!.location.line).toBeGreaterThanOrEqual(1);
    expect(sub!.location.col).toBeGreaterThanOrEqual(1);
    expect(sub!.location.snippet).toContain('$ARGUMENTS');
  });
});

describe('parseSkill — metadata enforcement', () => {
  it('refuses non-object metadata', () => {
    const raw = md('name: sample-skill\ndescription: x\nmetadata: "hello"');
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/metadata must be a flat object/);
  });

  it('refuses array metadata', () => {
    const raw = md('name: sample-skill\ndescription: x\nmetadata:\n  - a\n  - b');
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/metadata must be a flat object/);
  });

  it('refuses non-string metadata values', () => {
    const raw = md('name: sample-skill\ndescription: x\nmetadata:\n  count: 42');
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/metadata\.count must be a string/);
  });

  it('refuses nested object metadata values', () => {
    const raw = md('name: sample-skill\ndescription: x\nmetadata:\n  nested:\n    a: b');
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/must be a string/);
  });

  it('accepts flat string→string metadata', () => {
    const raw = md(
      'name: sample-skill\ndescription: x\nmetadata:\n  author: alice\n  version: "1.0"',
    );
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.metadata.author).toBe('alice');
    expect(r.skill.metadata.version).toBe('1.0');
  });
});

describe('parseSkill — Tier-2 passthrough into metadata', () => {
  it('captures license + compatibility + when_to_use', () => {
    const raw = md(
      'name: sample-skill\ndescription: x\nlicense: MIT\ncompatibility: claude-code, goose\nwhen_to_use: When asked about widgets.',
    );
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.metadata.license).toBe('MIT');
    expect(r.skill.metadata.compatibility).toBe('claude-code, goose');
    expect(r.skill.metadata.when_to_use).toBe('When asked about widgets.');
  });

  it('caps license at 500 chars', () => {
    const long = 'L'.repeat(600);
    const r = parseSkill(dir, md(`name: sample-skill\ndescription: x\nlicense: "${long}"`), ['SKILL.md']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.metadata.license!.length).toBe(500);
  });

  it('captures allowed-tools as comma-joined string', () => {
    const raw = md(
      'name: sample-skill\ndescription: x\nallowed-tools:\n  - web_search\n  - fetch_url',
    );
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.metadata['allowed-tools']).toBe('web_search,fetch_url');
    expect(r.warnings).toEqual([]);
  });

  it('warns once per unsupported allowed-tool', () => {
    const raw = md(
      'name: sample-skill\ndescription: x\nallowed-tools:\n  - Read\n  - Edit\n  - web_search',
    );
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toContain('allowed_tools_unsupported: Read');
    expect(r.warnings).toContain('allowed_tools_unsupported: Edit');
    expect(r.warnings).not.toContain('allowed_tools_unsupported: web_search');
  });

  it('accepts allowed-tools as single string', () => {
    const r = parseSkill(
      dir,
      md('name: sample-skill\ndescription: x\nallowed-tools: web_search'),
      ['SKILL.md'],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.metadata['allowed-tools']).toBe('web_search');
  });

  it('captures paths as comma-joined string (inert)', () => {
    const raw = md(
      'name: sample-skill\ndescription: x\npaths:\n  - "**/*.ts"\n  - "src/**"',
    );
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.metadata.paths).toBe('**/*.ts,src/**');
  });

  it('captures Claude Code interactive fields into metadata', () => {
    const raw = md(
      'name: sample-skill\ndescription: x\nmodel: claude-sonnet-4-5\neffort: high\nuser-invocable: true',
    );
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.metadata.model).toBe('claude-sonnet-4-5');
    expect(r.skill.metadata.effort).toBe('high');
    // non-string values are JSON-encoded.
    expect(r.skill.metadata['user-invocable']).toBe('true');
  });

  it('does not warn on CLI-interactive fields', () => {
    const r = parseSkill(
      dir,
      md('name: sample-skill\ndescription: x\nmodel: claude-sonnet-4-5'),
      ['SKILL.md'],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
  });
});

describe('parseSkill — malformed input', () => {
  it('returns parse_error on unparseable frontmatter', () => {
    const raw = '---\nname: [unterminated\n---\nbody';
    const r = parseSkill(dir, raw, ['SKILL.md']);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'parse_error') return;
    expect(r.message).toMatch(/frontmatter_parse_error/);
  });
});
