import { describe, expect, it } from 'vitest';
import { inferProvider } from '../../lib/providers/router.js';

describe('inferProvider', () => {
  it('maps Anthropic model ids', () => {
    expect(inferProvider('claude-sonnet-4-5')).toBe('anthropic');
    expect(inferProvider('claude-opus-4-5')).toBe('anthropic');
    expect(inferProvider('claude-haiku-4-5')).toBe('anthropic');
  });

  it('maps OpenAI model ids', () => {
    expect(inferProvider('gpt-5')).toBe('openai');
    expect(inferProvider('gpt-5-mini')).toBe('openai');
    expect(inferProvider('o3-mini')).toBe('openai');
    expect(inferProvider('text-embedding-3-small')).toBe('openai');
  });

  it('maps Gemini model ids', () => {
    expect(inferProvider('gemini-3-pro')).toBe('gemini');
    expect(inferProvider('gemini-2.5-pro')).toBe('gemini');
    expect(inferProvider('gemini-2.5-flash-image')).toBe('gemini');
  });

  it('returns null for unknown model strings', () => {
    expect(inferProvider('llama-3.1-70b')).toBeNull();
    expect(inferProvider('mistral-large')).toBeNull();
    expect(inferProvider('')).toBeNull();
  });
});
