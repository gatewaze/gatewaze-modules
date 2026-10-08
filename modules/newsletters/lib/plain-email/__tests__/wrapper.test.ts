import { describe, expect, it } from 'vitest';
import {
  BUILTIN_WRAPPER_META_KEY,
  PLAIN_EMAIL_WRAPPER,
  PLAIN_SHELL_DIRECTIVE,
  builtinWrapperFor,
  isBuiltinWrapperKey,
  isPlainShell,
} from '../wrapper.js';

describe('plain-email wrapper', () => {
  it('carries the shell directive and the body slot, and nothing that styles text', () => {
    expect(PLAIN_EMAIL_WRAPPER.startsWith(PLAIN_SHELL_DIRECTIVE)).toBe(true);
    expect(PLAIN_EMAIL_WRAPPER).toContain('<slot name="body" />');
    // The reader's client decides font, size, colour and alignment.
    expect(PLAIN_EMAIL_WRAPPER).not.toMatch(/font-family|font-size|color\s*:|text-align|background|margin/i);
    // A single unsubscribe link as plain text, spaced off the message with
    // line breaks, guarded so web/canvas renders drop it.
    expect(PLAIN_EMAIL_WRAPPER).toMatch(/<div if="edition\.unsubscribe_url">\s*(<br \/>\s*){3}<a href="\{\{edition\.unsubscribe_url\}\}">Unsubscribe<\/a>/);
    expect(PLAIN_EMAIL_WRAPPER).not.toContain('manage_subscriptions_url');
    expect(PLAIN_EMAIL_WRAPPER).not.toMatch(/preferences/i);
  });

  it('recognises the directive regardless of spacing and case', () => {
    expect(isPlainShell(PLAIN_EMAIL_WRAPPER)).toBe(true);
    expect(isPlainShell('<!--SHELL:plain-->\n<slot name="body" />')).toBe(true);
    expect(isPlainShell('<!-- shell: PLAIN -->')).toBe(true);
    expect(isPlainShell('<Section><slot name="body" /></Section>')).toBe(false);
    expect(isPlainShell(null)).toBe(false);
    expect(isPlainShell(undefined)).toBe(false);
  });

  it('resolves a built-in wrapper from collection metadata, and only a known key', () => {
    expect(builtinWrapperFor({ [BUILTIN_WRAPPER_META_KEY]: 'plain' })).toBe(PLAIN_EMAIL_WRAPPER);
    expect(builtinWrapperFor({ [BUILTIN_WRAPPER_META_KEY]: 'nope' })).toBeNull();
    expect(builtinWrapperFor({})).toBeNull();
    expect(builtinWrapperFor(null)).toBeNull();
    expect(isBuiltinWrapperKey('plain')).toBe(true);
    expect(isBuiltinWrapperKey('__proto__')).toBe(false);
    expect(isBuiltinWrapperKey('constructor')).toBe(false);
  });
});
