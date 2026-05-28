import { describe, expect, it } from 'vitest';
import {
  validateGenerateOutput,
  validateEditBlockOutput,
} from '../lib/output-validator.js';
import type { BlockDefView, PuckData } from '../lib/types.js';

const blockDefs: BlockDefView[] = [
  {
    id: 'def-hero',
    key: 'hero',
    name: 'Hero',
    has_bricks: false,
    theme_kind: 'website',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        headline: { type: 'string' },
        subhead: { type: 'string' },
        image: { type: 'string', format: 'image' },
        body: { type: 'string', format: 'richtext' },
        href: { type: 'string', format: 'link' },
      },
      required: ['headline'],
    },
  },
  {
    id: 'def-cta',
    key: 'cta',
    name: 'CTA',
    has_bricks: false,
    theme_kind: 'website',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: { type: 'string' },
      },
      required: ['label'],
    },
  },
];

describe('validateGenerateOutput — happy path', () => {
  it('passes through a valid hero block, assigning a server id', () => {
    const out = validateGenerateOutput({
      mode: 'replace',
      blockDefs,
      output: {
        content: [{ type: 'hero', props: { headline: 'Hello' } }],
      },
    });
    expect(out.blocksDropped).toBe(0);
    expect(out.data.content).toHaveLength(1);
    expect(out.data.content[0]?.props.id).toBeTruthy();
    expect(out.data.content[0]?.props.headline).toBe('Hello');
  });
});

describe('validateGenerateOutput — drops invalid blocks', () => {
  it('drops blocks with unknown type', () => {
    const out = validateGenerateOutput({
      mode: 'replace',
      blockDefs,
      output: {
        content: [
          { type: 'hero', props: { headline: 'ok' } },
          { type: 'made_up_block', props: { foo: 'bar' } },
        ],
      },
    });
    expect(out.blocksDropped).toBe(1);
    expect(out.dropReasons[0]?.reason).toBe('unknown_block_type');
  });

  it('drops blocks that fail ajv schema', () => {
    const out = validateGenerateOutput({
      mode: 'replace',
      blockDefs,
      // missing required `headline`
      output: { content: [{ type: 'hero', props: { subhead: 'no headline' } }] },
    });
    expect(out.blocksDropped).toBe(1);
    expect(out.dropReasons[0]?.reason).toBe('schema_violation');
  });

  it('drops blocks with extra properties (additionalProperties: false)', () => {
    const out = validateGenerateOutput({
      mode: 'replace',
      blockDefs,
      output: {
        content: [{ type: 'hero', props: { headline: 'ok', sneaky: 'value' } }],
      },
    });
    expect(out.blocksDropped).toBe(1);
  });

  it('drops content that is not an array', () => {
    const out = validateGenerateOutput({
      mode: 'replace',
      blockDefs,
      output: { content: 'lol' },
    });
    expect(out.warnings).toContain('content_not_array');
  });
});

describe('validateGenerateOutput — sanitisation', () => {
  it('strips <script> from generic string fields', () => {
    const out = validateGenerateOutput({
      mode: 'replace',
      blockDefs,
      output: {
        content: [
          {
            type: 'hero',
            props: { headline: 'Hello<script>alert(1)</script>', subhead: 'safe' },
          },
        ],
      },
    });
    expect(out.data.content[0]?.props.headline).toBe('Hello');
  });

  it('forces image fields to empty string and warns', () => {
    const out = validateGenerateOutput({
      mode: 'replace',
      blockDefs,
      output: {
        content: [
          {
            type: 'hero',
            props: { headline: 'h', image: 'https://attacker.example/x.png' },
          },
        ],
      },
    });
    expect(out.data.content[0]?.props.image).toBe('');
    expect(out.warnings.some((w) => w.startsWith('image_field_dropped'))).toBe(true);
  });

  it('runs DOMPurify on richtext fields, stripping scripts', () => {
    const out = validateGenerateOutput({
      mode: 'replace',
      blockDefs,
      output: {
        content: [
          {
            type: 'hero',
            props: {
              headline: 'h',
              body: '<p>ok</p><script>alert(1)</script><iframe src=x></iframe>',
            },
          },
        ],
      },
    });
    const body = out.data.content[0]?.props.body as string;
    expect(body).toContain('<p>ok</p>');
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('<iframe');
  });

  it('rejects javascript: hrefs on link fields', () => {
    const out = validateGenerateOutput({
      mode: 'replace',
      blockDefs,
      output: {
        content: [
          {
            type: 'hero',
            props: { headline: 'h', href: 'javascript:alert(1)' },
          },
        ],
      },
    });
    expect(out.data.content[0]?.props.href).toBe('');
    expect(out.warnings.some((w) => w.startsWith('bad_link_dropped'))).toBe(true);
  });

  it('accepts https / mailto / tel / relative hrefs', () => {
    const cases = ['https://x.com/path', 'mailto:a@b', 'tel:+1', '/relative'];
    for (const href of cases) {
      const out = validateGenerateOutput({
        mode: 'replace',
        blockDefs,
        output: { content: [{ type: 'hero', props: { headline: 'h', href } }] },
      });
      expect(out.data.content[0]?.props.href).toBe(href);
    }
  });
});

describe('validateGenerateOutput — edit-mode id rules', () => {
  const currentData: PuckData = {
    content: [
      { type: 'hero', props: { id: 'a', headline: 'old' } },
      { type: 'cta', props: { id: 'b', label: 'old' } },
    ],
    root: { props: {} },
  };

  it('preserves a matched id when type matches', () => {
    const out = validateGenerateOutput({
      mode: 'edit',
      blockDefs,
      currentData,
      output: {
        content: [{ type: 'hero', props: { id: 'a', headline: 'new' } }],
      },
    });
    expect(out.data.content[0]?.props.id).toBe('a');
  });

  it('drops blocks where id-type mismatches existing', () => {
    const out = validateGenerateOutput({
      mode: 'edit',
      blockDefs,
      currentData,
      // id 'a' is currently a hero, LLM tries to claim it as cta.
      output: { content: [{ type: 'cta', props: { id: 'a', label: 'x' } }] },
    });
    expect(out.blocksDropped).toBe(1);
    expect(out.dropReasons[0]?.reason).toBe('id_type_mismatch');
  });

  it('treats unmatched id as a fresh insert and warns', () => {
    const out = validateGenerateOutput({
      mode: 'edit',
      blockDefs,
      currentData,
      output: {
        content: [{ type: 'hero', props: { id: 'ghost', headline: 'new' } }],
      },
    });
    expect(out.data.content[0]?.props.id).not.toBe('ghost');
    expect(out.warnings.some((w) => w.includes('ai_unmatched_id'))).toBe(true);
  });
});

describe('validateEditBlockOutput', () => {
  it('returns sanitised props for a valid edit', () => {
    const res = validateEditBlockOutput(
      { props: { headline: 'New' } },
      blockDefs[0]!,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.props.headline).toBe('New');
  });

  it('rejects schema-violating props', () => {
    const res = validateEditBlockOutput({ props: {} }, blockDefs[0]!);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('schema_violation');
  });

  it('rejects non-object output', () => {
    const res = validateEditBlockOutput('not an object', blockDefs[0]!);
    expect(res.ok).toBe(false);
  });

  it('forces image field to empty string in edit-block mode too', () => {
    const res = validateEditBlockOutput(
      { props: { headline: 'h', image: 'https://x/y.png' } },
      blockDefs[0]!,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.props.image).toBe('');
      expect(res.warnings.some((w) => w.startsWith('image_field_dropped'))).toBe(true);
    }
  });
});
