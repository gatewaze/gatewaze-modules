/**
 * Shared styles for the native react-email ports of the legacy MLOps
 * newsletter blocks. These mirror the inline styles the original Mustache
 * templates used (650px column, #4086c6 brand blue, the bordered card, the
 * small eyebrow label, the 24px heading), so converted blocks stay visually
 * consistent with the originals without each repeating the style objects.
 */

import type { CSSProperties } from 'react';

/** 650px centred column — the authored email width. */
export const COLUMN: CSSProperties = { width: '650px', maxWidth: '650px', margin: '0 auto' };

/** Fully-bordered rounded card (most content blocks). */
export const BORDERED_CARD: CSSProperties = {
  ...COLUMN,
  border: '1px solid #4086c6',
  borderRadius: '15px',
  color: '#000',
  padding: '15px',
};

/** Small uppercase brand-blue label above a heading. */
export const EYEBROW: CSSProperties = {
  margin: '0 0 4px',
  fontSize: '12px',
  color: '#4086c6',
  fontWeight: 'bold',
};

/** Section heading. */
export const TITLE: CSSProperties = {
  margin: '0 0 8px',
  fontSize: '24px',
  fontWeight: 'bold',
  color: '#000',
  lineHeight: 1.2,
};

/** Body / rich-text container. */
export const BODY: CSSProperties = { fontSize: '16px', color: '#555', lineHeight: 1.5 };

/** Brand-blue underlined link. */
export const LINK: CSSProperties = { textDecoration: 'underline', color: '#4086c6' };

/** Brick heading (community sub-items). */
export const BRICK_TITLE: CSSProperties = {
  margin: '0 0 8px',
  fontSize: '20px',
  fontWeight: 'bold',
  color: '#000',
  lineHeight: 1.2,
};

/** Thin divider between bricks. */
export const DIVIDER: CSSProperties = { border: 0, borderTop: '1px solid #bbb', margin: '10px 0' };
