/**
 * Social icons row composite — horizontal strip of social-link icons.
 * Mirrors the four-icon row in the Barebone footer (X / LinkedIn /
 * YouTube / GitHub). Each icon is shown only when its URL is set, so
 * an operator can enable just the channels they actually use without
 * leaving dead anchors in the markup.
 */

import { Img, Link, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface SocialIconsRowProps extends Record<string, unknown> {
  x_url: string;
  linkedin_url: string;
  youtube_url: string;
  github_url: string;
  icon_size: string;
  icon_set_base: string;
}

const SAFE_HREF = /^(https?:|mailto:|\/)/i;
function safeHref(value: unknown): string {
  return typeof value === 'string' && SAFE_HREF.test(value) ? value : '#';
}

export const SocialIconsRowBlock: EmailBlockEntry<SocialIconsRowProps> = {
  componentId: 'social_icons_row',
  label: 'Social icons',
  category: 'Social',
  fields: {
    x_url: { type: 'text', label: 'X / Twitter URL' },
    linkedin_url: { type: 'text', label: 'LinkedIn URL' },
    youtube_url: { type: 'text', label: 'YouTube URL' },
    github_url: { type: 'text', label: 'GitHub URL' },
    icon_size: { type: 'text', label: 'Icon size (px)' },
    icon_set_base: { type: 'text', label: 'Icon set base URL (folder containing social-x-black.png etc.)' },
  },
  defaultProps: {
    x_url: '',
    linkedin_url: '',
    youtube_url: '',
    github_url: '',
    icon_size: '18',
    icon_set_base: '/static/shared',
  },
  Component: ({ x_url, linkedin_url, youtube_url, github_url, icon_size, icon_set_base }) => {
    const size = parseInt(icon_size, 10);
    const w = Number.isFinite(size) && size > 0 ? size : 18;
    const base = icon_set_base.endsWith('/') ? icon_set_base.slice(0, -1) : icon_set_base;
    const items: Array<{ url: string; src: string; alt: string }> = [
      { url: x_url, src: `${base}/social-x-black.png`, alt: 'X' },
      { url: linkedin_url, src: `${base}/social-in-black.png`, alt: 'LinkedIn' },
      { url: youtube_url, src: `${base}/social-yt-black.png`, alt: 'YouTube' },
      { url: github_url, src: `${base}/social-gh-black.png`, alt: 'GitHub' },
    ].filter((it) => it.url && it.url.length > 0);
    if (items.length === 0) return null;
    return (
      <Section style={{ textAlign: 'center', padding: '16px 0' }}>
        {items.map((it) => (
          <Link
            key={it.alt}
            href={safeHref(it.url)}
            style={{ display: 'inline-block', padding: '0 8px', verticalAlign: 'middle' }}
          >
            <Img src={it.src} alt={it.alt} width={w} style={{ display: 'block' }} />
          </Link>
        ))}
      </Section>
    );
  },
};
