/**
 * The allowlist for the declarative block format: which html-ish tags map to
 * which react-email components, and which `class` names map to the shared
 * style objects. Anything not in TAG_COMPONENTS (and not a special tag handled
 * by the renderer — `richtext`, `slot`) is dropped. This allowlist is the
 * security boundary: the format can only ever produce these components.
 */

import type { ComponentType, CSSProperties } from 'react';
import { Section, Row, Column, Text, Heading, Img, Button, Link, Hr } from '@react-email/components';
import {
  COLUMN,
  BORDERED_CARD,
  EYEBROW,
  TITLE,
  BODY,
  LINK,
  BRICK_TITLE,
  DIVIDER,
} from '../blocks/_shared.js';

/** Allowlisted tag (lowercased) → react-email component. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TAG_COMPONENTS: Record<string, ComponentType<any>> = {
  section: Section,
  row: Row,
  column: Column,
  text: Text,
  heading: Heading,
  img: Img,
  button: Button,
  link: Link,
  hr: Hr,
  // Aliases for case-sensitive JSX tags that collide with HTML5 void elements
  // (parse-template rewrites them so DOMParser doesn't strip their children).
  'gw-link': Link,
};

/** Tags the renderer handles specially (not a plain component pass-through). */
export const SPECIAL_TAGS = new Set(['richtext', 'slot']);

/**
 * Plain inert HTML tags the renderer may emit directly (for layout/padding
 * wrappers and inline text formatting). Only `style` + PASSTHROUGH_ATTRS are
 * ever forwarded, so no event handlers / script can ride along. Anything not
 * here and not a react-email component is dropped.
 */
export const INTRINSIC_TAGS = new Set([
  'div', 'span', 'p', 'strong', 'em', 'b', 'i', 'u', 'br', 'ul', 'ol', 'li', 'small',
]);

/** `class` name → shared style object. Authors compose look via classes. */
export const CLASS_STYLES: Record<string, CSSProperties> = {
  column: COLUMN,
  card: BORDERED_CARD,
  eyebrow: EYEBROW,
  title: TITLE,
  body: BODY,
  link: LINK,
  'brick-title': BRICK_TITLE,
  divider: DIVIDER,
};

/** Attributes passed through to the component (after binding resolution). */
export const PASSTHROUGH_ATTRS = ['href', 'src', 'alt', 'target', 'width', 'height', 'align'] as const;

/** Merge one or more space-separated class names into a single style object. */
export function classStyle(classAttr: string | undefined): CSSProperties {
  if (!classAttr) return {};
  return classAttr
    .split(/\s+/)
    .filter(Boolean)
    .reduce<CSSProperties>((acc, c) => ({ ...acc, ...(CLASS_STYLES[c] ?? {}) }), {});
}

/** Parse an inline `style="a:b;c:d"` string into a (camelCased) style object. */
export function parseInlineStyle(style: string | undefined): CSSProperties {
  if (!style) return {};
  const out: Record<string, string> = {};
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim();
    const value = decl.slice(idx + 1).trim();
    if (!prop || !value) continue;
    const camel = prop.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    out[camel] = value;
  }
  return out as CSSProperties;
}
