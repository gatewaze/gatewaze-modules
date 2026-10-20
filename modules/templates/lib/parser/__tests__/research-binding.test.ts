import { describe, it, expect } from 'vitest';
import { validateResearchBinding, isResearchBinding } from '../research-binding.js';
import { parse } from '../parse.js';

const schema = { eyebrow: { type: 'text' }, items: { type: 'array', fields: { headline: { type: 'text' } } }, summary: { type: 'richtext' } };

const good = {
  kind: 'research',
  input: { kind: 'discovery_posts', window: 'since_previous_edition', foundations: 'all', require_date: true },
  transform: { kind: 'template', group_by: 'foundation', max_items: 40, max_per_group: 8 },
  output: { field: 'items' },
  schedule: 'edition',
};

describe('validateResearchBinding', () => {
  it('accepts the blogs block binding', () => {
    expect(validateResearchBinding(good, schema)).toEqual([]);
    expect(isResearchBinding(good)).toBe(true);
    expect(isResearchBinding({ adapter: 'http', url: 'x' })).toBe(false);
  });
  it('rejects unknown kinds, a missing output field, and an output field not in SCHEMA', () => {
    expect(validateResearchBinding({ ...good, input: { kind: 'rss' } }, schema).join()).toMatch(/input.kind/);
    expect(validateResearchBinding({ ...good, output: {} }, schema).join()).toMatch(/output.field is required/);
    expect(validateResearchBinding({ ...good, output: { field: 'nope' } }, schema).join()).toMatch(/not a field in SCHEMA/);
    expect(validateResearchBinding({ ...good, transform: { kind: 'magic' } }, schema).join()).toMatch(/transform.kind/);
  });
  it('rejects daily wherever a recipe appears, and a recipe step without a use case', () => {
    expect(validateResearchBinding({ ...good, schedule: 'daily' }, schema)).toEqual([]);
    expect(validateResearchBinding({ ...good, schedule: 'daily', input: { kind: 'recipe', use_case: 'newsletter-top-stories' } }, schema).join()).toMatch(/daily/);
    expect(validateResearchBinding({ ...good, schedule: 'daily', transform: { kind: 'recipe', use_case: 'newsletter-x' } }, schema).join()).toMatch(/daily/);
    expect(validateResearchBinding({ ...good, input: { kind: 'recipe' } }, schema).join()).toMatch(/input.use_case/);
    expect(validateResearchBinding({ ...good, transform: { kind: 'recipe' } }, schema).join()).toMatch(/transform.use_case/);
  });
  it('refuses reserved output fields, non-newsletter use cases and non-scalar params', () => {
    expect(validateResearchBinding({ ...good, output: { field: 'research_edits' } }, { ...schema, research_edits: { type: 'text' } }).join()).toMatch(/reserved/);
    expect(validateResearchBinding({ ...good, input: { kind: 'recipe', use_case: 'daily-briefing-research' } }, schema).join()).toMatch(/newsletter-/);
    expect(validateResearchBinding({ ...good, input: { kind: 'recipe', use_case: 'newsletter-x', params: { nested: { a: 1 } } } }, schema).join()).toMatch(/params/);
  });
  it('bounds caps and windows', () => {
    expect(validateResearchBinding({ ...good, transform: { kind: 'template', max_items: 0 } }, schema).join()).toMatch(/max_items/);
    expect(validateResearchBinding({ ...good, input: { kind: 'discovery_posts', window: { days: 400 } } }, schema).join()).toMatch(/window/);
    expect(validateResearchBinding({ ...good, input: { kind: 'discovery_posts', window: { days: 14 } } }, schema)).toEqual([]);
  });
});

describe('parse() with a research DATA_SOURCE', () => {
  const block = (ds: string) => `<!-- BLOCK:lf_blogs | name=LF blogs | sort_order=0 -->
<!-- SCHEMA:${JSON.stringify(schema)} -->
<!-- DATA_SOURCE:${ds} -->
<Section>{{eyebrow}}</Section>
<!-- /BLOCK:lf_blogs -->`;
  it('carries a valid binding through to data_source', () => {
    const r = parse(block(JSON.stringify(good)));
    expect(r.errors).toEqual([]);
    expect(r.block_defs[0].data_source).toMatchObject({ kind: 'research', output: { field: 'items' } });
  });
  it('rejects an invalid binding with a located error and drops it', () => {
    const r = parse(block(JSON.stringify({ ...good, output: { field: 'nope' } })));
    expect(r.errors.map((e) => e.code)).toContain('templates.parse.block_research_binding_invalid');
    expect(r.block_defs[0]?.data_source ?? null).toBeNull();
  });
});
