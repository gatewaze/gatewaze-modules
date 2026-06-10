/**
 * Bordered email card wrapper for the converted MLOps blocks.
 *
 * react-email's <Section> renders as a <table>, and CSS padding on the table
 * doesn't push the cell content inward — so the border/radius live on the
 * Section and the content padding goes on an inner <div>, matching how the
 * legacy mustache templates padded their `td.pad` cells.
 */

import type { ReactNode, CSSProperties } from 'react';
import { Section } from '@react-email/components';
import { BORDERED_CARD } from './_shared.js';

export function Card({
  children,
  padding = '15px',
  style,
}: {
  children: ReactNode;
  padding?: string;
  style?: CSSProperties;
}) {
  return (
    <Section style={{ ...BORDERED_CARD, ...style }}>
      <div style={{ padding }}>{children}</div>
    </Section>
  );
}
