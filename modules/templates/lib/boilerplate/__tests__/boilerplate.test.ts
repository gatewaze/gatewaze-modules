import { describe, expect, it } from 'vitest';
import { getBoilerplateConfig, isUsingDefaultBoilerplate } from '../index.js';

describe('getBoilerplateConfig', () => {
  it('returns the canonical newsletter URL when no env override', () => {
    const config = getBoilerplateConfig('newsletter', {});
    expect(config.url).toContain('gatewaze-template-newsletter');
    expect(config.branch).toBe('main');
    expect(config.label).toMatch(/newsletter/i);
  });

  it('returns the canonical site URL when no env override', () => {
    const config = getBoilerplateConfig('site', {});
    expect(config.url).toContain('gatewaze-template-site');
    expect(config.branch).toBe('main');
    expect(config.label).toMatch(/site/i);
  });

  it('honours GATEWAZE_NEWSLETTER_BOILERPLATE_URL env override', () => {
    const config = getBoilerplateConfig('newsletter', {
      GATEWAZE_NEWSLETTER_BOILERPLATE_URL: 'https://internal.example/forks/newsletter.git',
    });
    expect(config.url).toBe('https://internal.example/forks/newsletter.git');
  });

  it('honours branch + path overrides', () => {
    const config = getBoilerplateConfig('newsletter', {
      GATEWAZE_NEWSLETTER_BOILERPLATE_URL: 'https://example.com/x.git',
      GATEWAZE_NEWSLETTER_BOILERPLATE_BRANCH: 'release/v2',
      GATEWAZE_NEWSLETTER_BOILERPLATE_PATH: 'themes/wedding',
    });
    expect(config.branch).toBe('release/v2');
    expect(config.manifestPath).toBe('themes/wedding');
  });

  it('treats whitespace-only env values as unset (falls back to default)', () => {
    const config = getBoilerplateConfig('newsletter', {
      GATEWAZE_NEWSLETTER_BOILERPLATE_URL: '   ',
    });
    expect(config.url).toContain('gatewaze-template-newsletter');
  });

  it('site + newsletter envs are independent', () => {
    const env = {
      GATEWAZE_NEWSLETTER_BOILERPLATE_URL: 'https://nl.example/x.git',
      GATEWAZE_SITE_BOILERPLATE_URL: 'https://site.example/x.git',
    };
    expect(getBoilerplateConfig('newsletter', env).url).toBe('https://nl.example/x.git');
    expect(getBoilerplateConfig('site', env).url).toBe('https://site.example/x.git');
  });

  it('manifestPath is undefined (not empty string) when unset — so walker walks repo root', () => {
    const config = getBoilerplateConfig('newsletter', {});
    expect(config.manifestPath).toBeUndefined();
  });
});

describe('isUsingDefaultBoilerplate', () => {
  it('true when env unset', () => {
    expect(isUsingDefaultBoilerplate('newsletter', {})).toBe(true);
    expect(isUsingDefaultBoilerplate('site', {})).toBe(true);
  });

  it('false when env override is set', () => {
    expect(isUsingDefaultBoilerplate('newsletter', { GATEWAZE_NEWSLETTER_BOILERPLATE_URL: 'https://x.example/x.git' })).toBe(false);
  });

  it('true when env value is empty string', () => {
    expect(isUsingDefaultBoilerplate('newsletter', { GATEWAZE_NEWSLETTER_BOILERPLATE_URL: '' })).toBe(true);
  });
});
