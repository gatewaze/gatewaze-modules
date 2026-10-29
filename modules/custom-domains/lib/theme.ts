/**
 * The shape of custom_domains.theme, checked before it is written.
 *
 * The portal re-checks it on read (packages/portal/lib/custom-domain-theme.ts
 * carries the same rules), so this is the first of two gates, not the only
 * one. Tokens only: a hex colour, a font family name as a person types it,
 * an https logo, and two small enums. Anything else is named in `refused`
 * so the admin page can say what it would not keep.
 */

export type ThemeMode = 'dark' | 'light';
export type ThemeRadius = 'sharp' | 'soft' | 'round';

export interface CustomDomainTheme {
  mode?: ThemeMode;
  colors?: Partial<Record<'background' | 'surface' | 'text' | 'muted' | 'primary' | 'primaryText' | 'border', string>>;
  fonts?: { heading?: string; body?: string };
  logoUrl?: string;
  radius?: ThemeRadius;
}

const HEX = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
// No quote of either kind: the portal emits the name inside one.
const FONT = /^[A-Za-z0-9][A-Za-z0-9 +-]{0,60}$/;
const COLOR_KEYS = ['background', 'surface', 'text', 'muted', 'primary', 'primaryText', 'border'] as const;

/** `null` clears the theme; an object is kept only where every field passes. */
export function cleanTheme(raw: unknown): { theme: CustomDomainTheme | null; refused: string[] } {
  if (raw === null) return { theme: null, refused: [] };
  const refused: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { theme: null, refused: ['theme must be an object or null'] };
  const r = raw as Record<string, unknown>;
  const out: CustomDomainTheme = {};
  for (const k of Object.keys(r)) if (!['mode', 'colors', 'fonts', 'logoUrl', 'radius'].includes(k)) refused.push(k);
  if (r.mode !== undefined) {
    if (r.mode === 'dark' || r.mode === 'light') out.mode = r.mode;
    else refused.push('mode');
  }
  if (r.colors !== undefined) {
    if (!r.colors || typeof r.colors !== 'object' || Array.isArray(r.colors)) refused.push('colors');
    else {
      const c = r.colors as Record<string, unknown>;
      const colors: NonNullable<CustomDomainTheme['colors']> = {};
      for (const [k, v] of Object.entries(c)) {
        if (v === undefined || v === null || v === '') continue;
        if (!(COLOR_KEYS as readonly string[]).includes(k)) { refused.push(`colors.${k}`); continue; }
        if (typeof v !== 'string' || !HEX.test(v)) { refused.push(`colors.${k}`); continue; }
        colors[k as (typeof COLOR_KEYS)[number]] = v.toLowerCase();
      }
      if (Object.keys(colors).length) out.colors = colors;
    }
  }
  if (r.fonts !== undefined) {
    if (!r.fonts || typeof r.fonts !== 'object' || Array.isArray(r.fonts)) refused.push('fonts');
    else {
      const f = r.fonts as Record<string, unknown>;
      const fonts: NonNullable<CustomDomainTheme['fonts']> = {};
      for (const [k, v] of Object.entries(f)) {
        if (v === undefined || v === null || v === '') continue;
        if (k !== 'heading' && k !== 'body') { refused.push(`fonts.${k}`); continue; }
        if (typeof v !== 'string' || !FONT.test(v.trim())) { refused.push(`fonts.${k}`); continue; }
        fonts[k] = v.trim();
      }
      if (Object.keys(fonts).length) out.fonts = fonts;
    }
  }
  if (r.logoUrl !== undefined && r.logoUrl !== null && r.logoUrl !== '') {
    let ok = false;
    if (typeof r.logoUrl === 'string' && r.logoUrl.length <= 500 && !r.logoUrl.includes('\\')) {
      try { ok = new URL(r.logoUrl).protocol === 'https:'; } catch { ok = false; }
    }
    if (ok) out.logoUrl = r.logoUrl as string;
    else refused.push('logoUrl');
  }
  if (r.radius !== undefined && r.radius !== null && r.radius !== '') {
    if (r.radius === 'sharp' || r.radius === 'soft' || r.radius === 'round') out.radius = r.radius;
    else refused.push('radius');
  }
  return { theme: Object.keys(out).length ? out : null, refused };
}
