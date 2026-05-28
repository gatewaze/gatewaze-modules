import { describe, expect, it } from 'vitest';
import {
  buildWebSearchTool,
  FETCH_URL_TOOL,
  isFetchUrlInput,
} from '../lib/web-tools/tool-defs.js';

describe('buildWebSearchTool', () => {
  it('returns an Anthropic server-tool descriptor with the supplied max_uses', () => {
    const t = buildWebSearchTool(5);
    expect(t.type).toBe('web_search_20250305');
    expect(t.name).toBe('web_search');
    expect(t.max_uses).toBe(5);
  });
});

describe('FETCH_URL_TOOL', () => {
  it('declares both url and reason as required', () => {
    expect(FETCH_URL_TOOL.input_schema.required).toEqual(['url', 'reason']);
  });

  it('requires uri-format url', () => {
    expect(FETCH_URL_TOOL.input_schema.properties.url.format).toBe('uri');
  });
});

describe('isFetchUrlInput', () => {
  it('accepts a well-formed input', () => {
    expect(isFetchUrlInput({ url: 'https://example.com/', reason: 'because' })).toBe(true);
  });
  it.each([
    null,
    undefined,
    'string',
    {},
    { url: 'https://example.com/' }, // missing reason
    { reason: 'because' }, // missing url
    { url: 123, reason: 'because' }, // wrong type
    { url: 'https://example.com/', reason: 42 }, // wrong type
  ])('rejects %s', (bad) => {
    expect(isFetchUrlInput(bad)).toBe(false);
  });
});
