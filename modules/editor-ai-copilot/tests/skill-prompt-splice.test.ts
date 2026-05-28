import { describe, expect, it } from 'vitest';
import { buildGeneratePrompt, buildEditBlockPrompt } from '../lib/prompt-builder.js';
import type { BlockDefView } from '../lib/types.js';

const blockDefs: BlockDefView[] = [
  {
    id: 'def-hero',
    key: 'hero',
    name: 'Hero',
    has_bricks: false,
    theme_kind: 'website',
    schema: { type: 'object', properties: { headline: { type: 'string' } }, required: ['headline'] },
  },
];

describe('buildGeneratePrompt — AI Skills splice', () => {
  it('omits BRAND GUIDELINES section when no active skills', () => {
    const { systemPrompt } = buildGeneratePrompt({
      mode: 'replace',
      hostKind: 'site',
      themeKind: 'website',
      blockDefs,
      userPrompt: 'go',
    });
    expect(systemPrompt).not.toContain('BRAND GUIDELINES');
    expect(systemPrompt).not.toContain('<skill');
  });

  it('splices a single skill with XML-style boundary tag', () => {
    const { systemPrompt } = buildGeneratePrompt({
      mode: 'replace',
      hostKind: 'site',
      themeKind: 'website',
      blockDefs,
      userPrompt: 'go',
      activeSkills: [{ id: 'skl_abc', name: 'Tone', body: 'Be terse.' }],
    });
    expect(systemPrompt).toContain('BRAND GUIDELINES');
    expect(systemPrompt).toContain('<skill index="1" name="Tone" id="skl_abc">');
    expect(systemPrompt).toContain('Be terse.');
    expect(systemPrompt).toContain('</skill>');
  });

  it('preserves skill order (priority = array order)', () => {
    const { systemPrompt } = buildGeneratePrompt({
      mode: 'replace',
      hostKind: 'newsletter',
      themeKind: 'email',
      blockDefs,
      userPrompt: 'go',
      activeSkills: [
        { id: 'a', name: 'First', body: 'AAA' },
        { id: 'b', name: 'Second', body: 'BBB' },
      ],
    });
    const idxA = systemPrompt.indexOf('AAA');
    const idxB = systemPrompt.indexOf('BBB');
    expect(idxA).toBeGreaterThan(0);
    expect(idxB).toBeGreaterThan(idxA);
  });

  it('escapes double quotes in skill name attribute', () => {
    const { systemPrompt } = buildGeneratePrompt({
      mode: 'replace',
      hostKind: 'site',
      themeKind: 'website',
      blockDefs,
      userPrompt: 'go',
      activeSkills: [{ id: 'x', name: 'Hello "World"', body: 'b' }],
    });
    expect(systemPrompt).toContain('name="Hello &quot;World&quot;"');
  });
});

describe('buildEditBlockPrompt — AI Skills splice', () => {
  it('includes BRAND GUIDELINES block in edit-block mode', () => {
    const { systemPrompt } = buildEditBlockPrompt({
      blockDef: blockDefs[0]!,
      currentProps: { headline: 'Hello' },
      userPrompt: 'punchier',
      activeSkills: [{ id: 'skl_x', name: 'Tone', body: 'Be punchy.' }],
    });
    expect(systemPrompt).toContain('BRAND GUIDELINES');
    expect(systemPrompt).toContain('<skill index="1" name="Tone" id="skl_x">');
    expect(systemPrompt).toContain('Be punchy.');
  });
});
