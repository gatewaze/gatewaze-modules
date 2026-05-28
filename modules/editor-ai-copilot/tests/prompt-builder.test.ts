import { describe, expect, it } from 'vitest';
import {
  buildGeneratePrompt,
  buildEditBlockPrompt,
  buildGenerateToolSchema,
  buildEditBlockToolSchema,
} from '../lib/prompt-builder.js';
import type { BlockDefView } from '../lib/types.js';

const blockDefs: BlockDefView[] = [
  {
    id: 'def-hero',
    key: 'hero',
    name: 'Hero',
    description: 'Big banner with headline + subhead',
    has_bricks: false,
    theme_kind: 'website',
    schema: {
      type: 'object',
      properties: {
        headline: { type: 'string' },
        subhead: { type: 'string' },
      },
      required: ['headline'],
    },
  },
  {
    id: 'def-cta',
    key: 'cta',
    name: 'Call to action',
    has_bricks: false,
    theme_kind: 'website',
    schema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        href: { type: 'string', format: 'uri' },
      },
      required: ['label', 'href'],
    },
  },
];

describe('buildGeneratePrompt', () => {
  it('lists each available block key in the system prompt', () => {
    const { systemPrompt } = buildGeneratePrompt({
      mode: 'replace',
      hostKind: 'site',
      themeKind: 'website',
      blockDefs,
      userPrompt: 'Build a landing page',
    });
    expect(systemPrompt).toContain('"hero"');
    expect(systemPrompt).toContain('"cta"');
    expect(systemPrompt).toContain('AVAILABLE BLOCKS');
  });

  it('includes EMAIL-SPECIFIC CONSTRAINTS when themeKind=email', () => {
    const { systemPrompt } = buildGeneratePrompt({
      mode: 'replace',
      hostKind: 'newsletter',
      themeKind: 'email',
      blockDefs,
      userPrompt: 'Build a welcome edition',
    });
    expect(systemPrompt).toContain('EMAIL-SPECIFIC CONSTRAINTS');
  });

  it('does NOT include EMAIL-SPECIFIC CONSTRAINTS for website theme', () => {
    const { systemPrompt } = buildGeneratePrompt({
      mode: 'replace',
      hostKind: 'site',
      themeKind: 'website',
      blockDefs,
      userPrompt: 'go',
    });
    expect(systemPrompt).not.toContain('EMAIL-SPECIFIC CONSTRAINTS');
  });

  it('serialises current data when mode=edit', () => {
    const currentData = {
      content: [{ type: 'hero', props: { id: 'x', headline: 'old' } }],
      root: { props: {} },
    };
    const { systemPrompt } = buildGeneratePrompt({
      mode: 'edit',
      hostKind: 'site',
      themeKind: 'website',
      blockDefs,
      userPrompt: 'Polish the copy',
      currentData,
    });
    expect(systemPrompt).toContain('CURRENT PAGE STATE');
    expect(systemPrompt).toContain('"headline": "old"');
  });

  it('formats source docs with header per document', () => {
    const { systemPrompt } = buildGeneratePrompt({
      mode: 'replace',
      hostKind: 'site',
      themeKind: 'website',
      blockDefs,
      userPrompt: 'go',
      sourceDocs: [
        {
          doc_id: 'd1',
          filename: 'brief.md',
          source: 'upload',
          extracted_text: 'Hello world.',
        },
        {
          doc_id: 'd2',
          filename: 'speech.txt',
          source: 'url',
          extracted_text: 'Lorem ipsum.',
        },
      ],
    });
    expect(systemPrompt).toContain('SOURCE DOCUMENTS');
    expect(systemPrompt).toContain('brief.md');
    expect(systemPrompt).toContain('speech.txt');
    expect(systemPrompt).toContain('Hello world.');
    expect(systemPrompt).toContain('Lorem ipsum.');
  });

  it('emits a truncation warning when source docs exceed budget', () => {
    const huge = 'X'.repeat(1_000_000);
    const { warnings } = buildGeneratePrompt({
      mode: 'replace',
      hostKind: 'site',
      themeKind: 'website',
      blockDefs,
      userPrompt: 'go',
      sourceDocs: [
        { doc_id: 'a', filename: 'big.txt', source: 'upload', extracted_text: huge },
      ],
    });
    expect(warnings.some((w) => w.includes('source_doc_truncated'))).toBe(true);
  });
});

describe('buildEditBlockPrompt', () => {
  it('embeds the block schema and current props', () => {
    const { systemPrompt } = buildEditBlockPrompt({
      blockDef: blockDefs[0]!,
      currentProps: { headline: 'old', subhead: 'sub' },
      userPrompt: 'punchier',
    });
    expect(systemPrompt).toContain('emit_block_props');
    expect(systemPrompt).toContain('"hero"');
    expect(systemPrompt).toContain('"old"');
    expect(systemPrompt).toContain('Do not rename the block');
  });
});

describe('buildGenerateToolSchema', () => {
  it('produces a oneOf branch per block def', () => {
    const { schema, truncatedBlockKeys } = buildGenerateToolSchema(blockDefs);
    expect(truncatedBlockKeys).toEqual([]);
    const items = (schema as { properties: { content: { items: { oneOf: unknown[] } } } })
      .properties.content.items.oneOf;
    expect(items).toHaveLength(2);
    expect(schema).toHaveProperty('definitions');
  });

  it('allows an id field when option set', () => {
    const { schema } = buildGenerateToolSchema(blockDefs, { allowIdField: true });
    const defs = (schema as { definitions: Record<string, { properties: Record<string, unknown> }> }).definitions;
    expect(defs.hero_props?.properties).toHaveProperty('id');
  });
});

describe('buildEditBlockToolSchema', () => {
  it('wraps the block schema in { props: <schema> }', () => {
    const schema = buildEditBlockToolSchema(blockDefs[0]!);
    expect(schema).toMatchObject({
      type: 'object',
      required: ['props'],
    });
    expect((schema as { properties: { props: unknown } }).properties.props).toBeTruthy();
  });
});
