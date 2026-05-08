// @ts-nocheck — vitest types resolved at workspace install time
/**
 * theme_kind filter test — Per spec-builder-evaluation §3.6.
 *
 * One library can host both website and email blocks. The Config
 * adapter must surface only the channel matching the current edit
 * session — a website session must NOT see email blocks (and vice
 * versa) even though they live in the same library.
 */
import { describe, expect, it } from 'vitest';
import { buildPuckConfig } from '../PuckConfigAdapter.js';
import type { BlockDefRow, BrickDefRow, PuckRenderHost } from '../types.js';

const renderHost: PuckRenderHost = {
  renderBlock: () => null as never,
  showMediaPicker: () => undefined,
};

const mixedLibrary: BlockDefRow[] = [
  { id: 'wb-hero', key: 'hero', name: 'Hero (Website)',
    has_bricks: false, is_current: true, theme_kind: 'website',
    html: '<section><h1>{{title}}</h1></section>',
    schema: { type: 'object', properties: { title: { type: 'string' } } } },
  { id: 'em-hero', key: 'email_hero', name: 'Hero (Email)',
    has_bricks: false, is_current: true, theme_kind: 'email',
    html: '<table><tr><td><h1>{{title}}</h1></td></tr></table>',
    schema: { type: 'object', properties: { title: { type: 'string' } } } },
  { id: 'em-cta', key: 'email_cta', name: 'CTA Button (Email)',
    has_bricks: false, is_current: true, theme_kind: 'email',
    html: '<table><tr><td><a href="{{href}}">{{label}}</a></td></tr></table>',
    schema: { type: 'object', properties: { href: { type: 'string', format: 'link' }, label: { type: 'string' } } } },
];

const mixedBricks: BrickDefRow[] = [];

describe('PuckConfigAdapter — theme_kind filter', () => {
  it('website mode emits only website blocks', () => {
    const result = buildPuckConfig({
      libraryId: 'lib-mixed',
      blockDefs: mixedLibrary,
      brickDefs: mixedBricks,
      wrappers: [],
      themeKind: 'website',
      renderHost,
    });
    const keys = Object.keys(result.config.components);
    expect(keys).toContain('hero');
    expect(keys).not.toContain('email_hero');
    expect(keys).not.toContain('email_cta');
  });

  it('email mode emits only email blocks', () => {
    const result = buildPuckConfig({
      libraryId: 'lib-mixed',
      blockDefs: mixedLibrary,
      brickDefs: mixedBricks,
      wrappers: [],
      themeKind: 'email',
      renderHost,
    });
    const keys = Object.keys(result.config.components);
    expect(keys).toContain('email_hero');
    expect(keys).toContain('email_cta');
    expect(keys).not.toContain('hero');
  });

  it('emits no blocks when the library has nothing for the requested channel', () => {
    const result = buildPuckConfig({
      libraryId: 'lib-empty',
      blockDefs: mixedLibrary.filter((d) => d.theme_kind === 'website'),
      brickDefs: [],
      wrappers: [],
      themeKind: 'email',
      renderHost,
    });
    expect(Object.keys(result.config.components)).toEqual([]);
  });

  it('produces stable fingerprints per channel', () => {
    const w1 = buildPuckConfig({
      libraryId: 'lib-mixed', blockDefs: mixedLibrary, brickDefs: [], wrappers: [],
      themeKind: 'website', renderHost,
    });
    const w2 = buildPuckConfig({
      libraryId: 'lib-mixed', blockDefs: mixedLibrary, brickDefs: [], wrappers: [],
      themeKind: 'website', renderHost,
    });
    const e1 = buildPuckConfig({
      libraryId: 'lib-mixed', blockDefs: mixedLibrary, brickDefs: [], wrappers: [],
      themeKind: 'email', renderHost,
    });
    expect(w1.fingerprint).toBe(w2.fingerprint);
    // Note: fingerprint key set differs per channel — they SHOULD differ.
    expect(w1.fingerprint).not.toBe(e1.fingerprint);
  });

  it('filters bricks by theme_kind too', () => {
    const blocks: BlockDefRow[] = [
      { id: 'wb-cols', key: 'cols', name: 'Cols',
        has_bricks: true, is_current: true, theme_kind: 'website',
        html: '<div>{{>children}}</div>', schema: {} },
      { id: 'em-cols', key: 'email_cols', name: 'Email Cols',
        has_bricks: true, is_current: true, theme_kind: 'email',
        html: '<table>{{>children}}</table>', schema: {} },
    ];
    const bricks: BrickDefRow[] = [
      { id: 'wb-tx', key: 'wtext', name: 'Text', parent_block_def_key: 'cols',
        parent_block_def_id: 'wb-cols', is_current: true, theme_kind: 'website',
        html: '<div>{{body}}</div>',
        schema: { type: 'object', properties: { body: { type: 'string' } } } },
      { id: 'em-tx', key: 'etext', name: 'Email Text', parent_block_def_key: 'email_cols',
        parent_block_def_id: 'em-cols', is_current: true, theme_kind: 'email',
        html: '<td>{{body}}</td>',
        schema: { type: 'object', properties: { body: { type: 'string' } } } },
    ];
    const w = buildPuckConfig({
      libraryId: 'lib', blockDefs: blocks, brickDefs: bricks, wrappers: [],
      themeKind: 'website', renderHost,
    });
    expect(Object.keys(w.config.components)).toEqual(expect.arrayContaining(['cols', 'wtext']));
    expect(Object.keys(w.config.components)).not.toContain('email_cols');
    expect(Object.keys(w.config.components)).not.toContain('etext');
  });
});
