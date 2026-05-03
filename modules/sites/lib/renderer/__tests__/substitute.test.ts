import { describe, expect, it } from 'vitest';
import { substitute } from '../substitute.js';

describe('substitute() — variables', () => {
  it('substitutes a single-stash variable (escaped)', () => {
    expect(substitute('Hello {{name}}', { name: 'world' })).toBe('Hello world');
  });

  it('escapes HTML in single-stash output', () => {
    expect(substitute('{{html}}', { html: '<b>x</b>' })).toBe('&lt;b&gt;x&lt;/b&gt;');
  });

  it('does NOT escape triple-stash output', () => {
    expect(substitute('{{{html}}}', { html: '<b>x</b>' })).toBe('<b>x</b>');
  });

  it('does NOT escape ampersand-prefixed output', () => {
    expect(substitute('{{& html}}', { html: '<b>x</b>' })).toBe('<b>x</b>');
  });

  it('renders missing keys as empty string', () => {
    expect(substitute('Hello {{missing}}!', {})).toBe('Hello !');
  });

  it('descends dotted keys', () => {
    expect(substitute('{{seo.title}}', { seo: { title: 'My Site' } })).toBe('My Site');
  });

  it('coerces numbers to strings', () => {
    expect(substitute('Count: {{n}}', { n: 42 })).toBe('Count: 42');
  });

  it('tolerates whitespace inside delimiters', () => {
    expect(substitute('Hello {{  name  }}', { name: 'X' })).toBe('Hello X');
  });
});

describe('substitute() — sections', () => {
  it('renders truthy sections', () => {
    expect(substitute('{{#yes}}A{{/yes}}', { yes: true })).toBe('A');
    expect(substitute('{{#yes}}A{{/yes}}', { yes: false })).toBe('');
    expect(substitute('{{#yes}}A{{/yes}}', {})).toBe('');
  });

  it('renders inverted sections (^) for falsy', () => {
    expect(substitute('{{^no}}A{{/no}}', { no: false })).toBe('A');
    expect(substitute('{{^no}}A{{/no}}', {})).toBe('A');
    expect(substitute('{{^no}}A{{/no}}', { no: true })).toBe('');
    expect(substitute('{{^items}}none{{/items}}', { items: [] })).toBe('none');
  });

  it('iterates over arrays', () => {
    expect(
      substitute('{{#items}}<li>{{name}}</li>{{/items}}', {
        items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      }),
    ).toBe('<li>a</li><li>b</li><li>c</li>');
  });

  it('walks parent scope from inside a section', () => {
    expect(
      substitute('{{#items}}{{prefix}}: {{name}};{{/items}}', {
        prefix: 'item',
        items: [{ name: 'a' }, { name: 'b' }],
      }),
    ).toBe('item: a;item: b;');
  });

  it('renders an object section once with its scope', () => {
    expect(
      substitute('{{#user}}{{name}} ({{role}}){{/user}}', {
        user: { name: 'Dan', role: 'admin' },
      }),
    ).toBe('Dan (admin)');
  });

  it('treats truthy primitives as section guards (renders body once)', () => {
    expect(substitute('{{#flag}}A{{/flag}}', { flag: 1 })).toBe('A');
    expect(substitute('{{#flag}}A{{/flag}}', { flag: 'yes' })).toBe('A');
  });

  it('throws on unbalanced sections', () => {
    expect(() => substitute('{{#a}}body', {})).toThrow(/unbalanced/);
    expect(() => substitute('body{{/a}}', {})).toThrow(/unbalanced/);
  });
});

describe('substitute() — partials', () => {
  it('substitutes a partial reference', () => {
    expect(
      substitute('<main>{{>body}}</main>', {}, { partials: { body: 'PAGE' } }),
    ).toBe('<main>PAGE</main>');
  });

  it('renders partials with view scope (so blocks can use {{site.name}})', () => {
    expect(
      substitute(
        '<main>{{>body}}</main>',
        { site: { name: 'AAIF' } },
        { partials: { body: '{{site.name}}' } },
      ),
    ).toBe('<main>AAIF</main>');
  });

  it('renders missing partials as empty', () => {
    expect(substitute('A{{>none}}B', {})).toBe('AB');
  });

  it('respects maxPartialDepth to bound recursion', () => {
    expect(
      substitute('{{>a}}', {}, { partials: { a: 'A{{>a}}' }, maxPartialDepth: 3 }),
    ).toBe('AAA');
  });
});

describe('substitute() — comments', () => {
  it('strips {{! comment }}', () => {
    expect(substitute('A{{!hello there}}B', {})).toBe('AB');
  });
});

describe('substitute() — XSS hardening', () => {
  it('does not allow user data to inject HTML through single-stash', () => {
    expect(substitute('{{ x }}', { x: '<img src=x onerror=alert(1)>' })).toBe(
      '&lt;img src&#x3D;x onerror&#x3D;alert(1)&gt;',
    );
  });

  it('triple-stash bypasses escaping (templates lint enforces use only on html-typed fields)', () => {
    expect(substitute('{{{ x }}}', { x: '<a>ok</a>' })).toBe('<a>ok</a>');
  });
});
