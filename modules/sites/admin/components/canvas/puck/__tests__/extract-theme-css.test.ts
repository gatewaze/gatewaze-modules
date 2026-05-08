// @ts-nocheck — vitest types resolved at workspace install time
import { describe, expect, it } from 'vitest';
import { extractThemeCss } from '../extract-theme-css.js';

describe('extractThemeCss', () => {
  it('returns empty when html has no <head>', () => {
    const r = extractThemeCss('<div>plain content</div>');
    expect(r.inline).toBe('');
    expect(r.externalLinks).toEqual([]);
  });

  it('captures inline <style> blocks from <head>', () => {
    const html = `<!doctype html>
<html><head>
<style>body { margin: 0 }</style>
<style type="text/css">.hero { color: red }</style>
</head><body><h1>x</h1></body></html>`;
    const r = extractThemeCss(html);
    expect(r.inline).toContain('body { margin: 0 }');
    expect(r.inline).toContain('.hero { color: red }');
    expect(r.externalLinks).toEqual([]);
  });

  it('captures external stylesheet links', () => {
    const html = `<head>
<link rel="preconnect" href="https://fonts.gstatic.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Inter">
<link href="/theme/site.css" rel="stylesheet">
</head>`;
    const r = extractThemeCss(html);
    expect(r.externalLinks).toEqual([
      'https://fonts.googleapis.com/css?family=Inter',
      '/theme/site.css',
    ]);
  });

  it('ignores <style> outside <head>', () => {
    const html = `<head><style>.in-head{x:1}</style></head><body><style>.in-body{y:2}</style></body>`;
    const r = extractThemeCss(html);
    expect(r.inline).toContain('.in-head{x:1}');
    expect(r.inline).not.toContain('.in-body');
  });

  it('handles missing href attribute gracefully', () => {
    const html = `<head><link rel="stylesheet"></head>`;
    const r = extractThemeCss(html);
    expect(r.externalLinks).toEqual([]);
  });
});
