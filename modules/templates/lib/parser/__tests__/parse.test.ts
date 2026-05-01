import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from '../parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(join(here, '__fixtures__', name), 'utf-8');

describe('parse() — happy paths', () => {
  it('parses a minimal single-block source', () => {
    const html = `
<!-- BLOCK:hero | name=Hero | description=Top hero | sort_order=0 -->
<!-- SCHEMA:{"type":"object","required":["title"],"properties":{"title":{"type":"string","title":"Title"}}} -->
<section class="hero">
  <h1>{{title}}</h1>
</section>
<!-- /BLOCK:hero -->
`;
    const result = parse(html);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.block_defs).toHaveLength(1);
    const block = result.block_defs[0]!;
    expect(block.key).toBe('hero');
    expect(block.name).toBe('Hero');
    expect(block.description).toBe('Top hero');
    expect(block.sort_order).toBe(0);
    expect(block.has_bricks).toBe(false);
    expect(block.schema['type']).toBe('object');
    expect(block.html).toContain('<h1>{{title}}</h1>');
    expect(block.bricks).toEqual([]);
  });

  it('humanises a block name when the name= attr is missing', () => {
    const html = `<!-- BLOCK:job_of_week --><!-- SCHEMA:{} --><div></div><!-- /BLOCK:job_of_week -->`;
    const result = parse(html);
    expect(result.errors).toEqual([]);
    expect(result.block_defs[0]?.name).toBe('Job Of Week');
  });

  it('parses bricks nested inside a has_bricks=true block', () => {
    const html = `
<!-- BLOCK:community | name=Community | has_bricks=true | sort_order=6 -->
<!-- SCHEMA:{"type":"object","properties":{}} -->
<div class="community">
  <h2>Community</h2>
  <!-- BRICK:podcast | name=Podcast | sort_order=1 -->
  <!-- SCHEMA:{"type":"object","properties":{"title":{"type":"string"}}} -->
  <article>{{title}}</article>
  <!-- /BRICK:podcast -->
  <!-- BRICK:blog_post | name=Blog Post | sort_order=2 -->
  <!-- SCHEMA:{"type":"object","properties":{"title":{"type":"string"}}} -->
  <article>{{title}}</article>
  <!-- /BRICK:blog_post -->
</div>
<!-- /BLOCK:community -->`;
    const result = parse(html);
    expect(result.errors).toEqual([]);
    const block = result.block_defs[0]!;
    expect(block.has_bricks).toBe(true);
    expect(block.bricks).toHaveLength(2);
    expect(block.bricks[0]?.key).toBe('podcast');
    expect(block.bricks[0]?.sort_order).toBe(1);
    expect(block.bricks[1]?.key).toBe('blog_post');
    // Brick region is replaced with {{bricks}} in the parent block body
    expect(block.html).toContain('{{bricks}}');
    expect(block.html).not.toContain('<!-- BRICK:');
  });

  it('extracts a WRAPPER with {{content}} slot and META blocks', () => {
    const html = `
<!-- WRAPPER:default | name=Default Shell -->
<!DOCTYPE html><html><head>
<!-- META:title -->{{page.title}}<!-- /META:title -->
<!-- META:description -->{{page.description}}<!-- /META:description -->
</head>
<body>{{content}}</body></html>
<!-- /WRAPPER:default -->`;
    const result = parse(html);
    expect(result.errors).toEqual([]);
    expect(result.wrappers).toHaveLength(1);
    expect(result.wrappers[0]?.key).toBe('default');
    expect(result.wrappers[0]?.meta_block_keys).toEqual(['title', 'description']);
  });

  it('extracts an optional DATA_SOURCE payload', () => {
    const html = `
<!-- BLOCK:upcoming_events | name=Upcoming Events -->
<!-- SCHEMA:{"type":"object","properties":{"limit":{"type":"integer"}}} -->
<!-- DATA_SOURCE:{"adapter":"events","operation":"list","params":{"limit":"{{limit}}"}} -->
<section>{{#items}}<article>{{name}}</article>{{/items}}</section>
<!-- /BLOCK:upcoming_events -->`;
    const result = parse(html);
    expect(result.errors).toEqual([]);
    expect(result.block_defs[0]?.data_source).toMatchObject({ adapter: 'events', operation: 'list' });
  });

  it('extracts a RICH_TEXT_TEMPLATE region and removes it from the block body', () => {
    const html = `
<!-- BLOCK:ai_summary -->
<!-- SCHEMA:{"properties":{"section_title":{"type":"string"}}} -->
<div>{{section_title}}</div>
<!-- RICH_TEXT_TEMPLATE -->
{{#section_title}}<h2>{{section_title}}</h2>{{/section_title}}
<!-- /RICH_TEXT_TEMPLATE -->
<!-- /BLOCK:ai_summary -->`;
    const result = parse(html);
    expect(result.errors).toEqual([]);
    const block = result.block_defs[0]!;
    expect(block.rich_text_template).toContain('{{section_title}}');
    expect(block.html).not.toContain('RICH_TEXT_TEMPLATE');
  });

  it('parses the mlops-community.html fixture without errors', () => {
    const html = fixture('mlops-community.html');
    const result = parse(html, { sourcePath: 'mlops-community.html' });
    // The mlops template uses some non-schema runtime globals; the parser
    // should succeed (no errors) but may emit warnings for refs we don't
    // recognise. The important thing is the structure parses correctly.
    expect(result.errors).toEqual([]);
    expect(result.block_defs.length).toBeGreaterThanOrEqual(10);
    const blockKeys = result.block_defs.map((b) => b.key);
    expect(blockKeys).toContain('header');
    expect(blockKeys).toContain('intro_paragraph');
    expect(blockKeys).toContain('hot_take');
    expect(blockKeys).toContain('mlops_community');
    expect(blockKeys).toContain('footer');
    // The MLOps community block has has_bricks=true with 3 bricks
    const community = result.block_defs.find((b) => b.key === 'mlops_community');
    expect(community?.has_bricks).toBe(true);
    expect(community?.bricks?.length).toBe(3);
  });
});

describe('parse() — validation errors', () => {
  it('rejects a BLOCK with no matching close', () => {
    const html = `<!-- BLOCK:hero --><!-- SCHEMA:{} --><h1>oops`;
    const result = parse(html);
    expect(result.errors.some((e) => e.code === 'templates.parse.block_unclosed')).toBe(true);
  });

  it('rejects a WRAPPER missing the {{content}} slot', () => {
    const html = `<!-- WRAPPER:bad --><html><body>no slot here</body></html><!-- /WRAPPER:bad -->`;
    const result = parse(html);
    expect(result.errors.some((e) => e.code === 'templates.parse.wrapper_missing_content_slot')).toBe(true);
  });

  it('rejects a WRAPPER with two {{content}} slots', () => {
    const html = `<!-- WRAPPER:bad --><body>{{content}} and {{content}}</body><!-- /WRAPPER:bad -->`;
    const result = parse(html);
    expect(result.errors.some((e) => e.code === 'templates.parse.wrapper_duplicate_content_slot')).toBe(true);
  });

  it('rejects malformed SCHEMA JSON', () => {
    const html = `<!-- BLOCK:bad --><!-- SCHEMA:{not valid json} --><div></div><!-- /BLOCK:bad -->`;
    const result = parse(html);
    expect(result.errors.some((e) => e.code === 'templates.parse.block_schema_invalid_json')).toBe(true);
  });

  it('rejects malformed DATA_SOURCE JSON', () => {
    const html = `<!-- BLOCK:bad --><!-- SCHEMA:{} --><!-- DATA_SOURCE:{not json} --><div></div><!-- /BLOCK:bad -->`;
    const result = parse(html);
    expect(result.errors.some((e) => e.code === 'templates.parse.block_data_source_invalid_json')).toBe(true);
  });

  it('rejects {{secret:*}} in block HTML body', () => {
    const html = `<!-- BLOCK:bad --><!-- SCHEMA:{} --><div data-k="{{secret:vercel_token}}"></div><!-- /BLOCK:bad -->`;
    const result = parse(html);
    expect(result.errors.some((e) => e.code === 'templates.lint.secret_in_html')).toBe(true);
  });

  it('does NOT reject {{secret:*}} inside a DATA_SOURCE payload', () => {
    const html = `
<!-- BLOCK:api_block | name=API Block -->
<!-- SCHEMA:{"properties":{"q":{"type":"string"}}} -->
<!-- DATA_SOURCE:{"adapter":"http","method":"GET","url":"https://api.example.com/items","headers":{"Authorization":"Bearer {{secret:api_token}}"}} -->
<section>{{#items}}<li>{{name}}</li>{{/items}}</section>
<!-- /BLOCK:api_block -->`;
    const result = parse(html);
    expect(result.errors).toEqual([]);
  });

  it('returns a single error for input over the byte cap', () => {
    const big = 'x'.repeat(200);
    const result = parse(big, { maxBytes: 100 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('templates.parse.input_too_large');
  });

  it('rejects a non-string input', () => {
    const result = parse(undefined as unknown as string);
    expect(result.errors[0]?.code).toBe('templates.parse.input_not_string');
  });
});

describe('parse() — warnings', () => {
  it('warns when a {{var}} reference does not resolve to schema or runtime globals', () => {
    const html = `<!-- BLOCK:b --><!-- SCHEMA:{"properties":{"title":{"type":"string"}}} --><h1>{{titel}}</h1><!-- /BLOCK:b -->`;
    const result = parse(html);
    expect(result.warnings.some((w) => w.code === 'templates.lint.unknown_mustache_ref')).toBe(true);
  });

  it('warns when {{{triple_stash}}} appears for a non-html field', () => {
    const html = `<!-- BLOCK:b --><!-- SCHEMA:{"properties":{"name":{"type":"string"}}} --><span>{{{name}}}</span><!-- /BLOCK:b -->`;
    const result = parse(html);
    expect(result.warnings.some((w) => w.code === 'templates.lint.triple_stash_non_html')).toBe(true);
  });

  it('does NOT warn when {{{var}}} appears for a format=html field', () => {
    const html = `<!-- BLOCK:b --><!-- SCHEMA:{"properties":{"body":{"type":"string","format":"html"}}} --><div>{{{body}}}</div><!-- /BLOCK:b -->`;
    const result = parse(html);
    expect(result.warnings.some((w) => w.code === 'templates.lint.triple_stash_non_html')).toBe(false);
  });

  it('warns when has_bricks=false but BRICK markers are present', () => {
    const html = `
<!-- BLOCK:b -->
<!-- SCHEMA:{} -->
<div>
  <!-- BRICK:foo --><!-- SCHEMA:{} --><span></span><!-- /BRICK:foo -->
</div>
<!-- /BLOCK:b -->`;
    const result = parse(html);
    expect(result.warnings.some((w) => w.code === 'templates.parse.block_bricks_present_without_flag')).toBe(true);
  });
});

describe('parse() — definition derivation', () => {
  it('synthesises a definition row when blocks are present', () => {
    const html = `<!-- BLOCK:a --><!-- SCHEMA:{} --><div></div><!-- /BLOCK:a -->`;
    const result = parse(html, { sourcePath: 'gatewaze/templates/landing.html' });
    expect(result.definitions).toHaveLength(1);
    expect(result.definitions[0]?.key).toBe('landing');
    expect(result.definitions[0]?.default_block_order).toEqual(['a']);
  });

  it('does NOT synthesise a definition when only a wrapper is present', () => {
    const html = `<!-- WRAPPER:shell --><body>{{content}}</body><!-- /WRAPPER:shell -->`;
    const result = parse(html);
    expect(result.definitions).toEqual([]);
  });
});
