/**
 * react-email block registry types. Per spec-builder-evaluation §3.6
 * (extended).
 *
 * Registry blocks ship as TSX components in this directory. Each block
 * is referenced by a stable `component_id` string that lives in the
 * `templates_block_defs.component_id` column. The publish-worker and
 * editor BOTH resolve component_id → registry entry via the same map.
 *
 * Why a registry (not loose imports): we need a single map at runtime
 * so the editor can mount the same Puck Config that the publish-worker
 * later renders against. Loose imports would diverge — the publish
 * path would have to know about every editor block file.
 */

import type { ComponentType } from 'react';
import type { Field } from '@puckeditor/core';

export type FormatId = 'substack' | 'beehiiv';

/**
 * Subset of Puck's `resolveData` signature surfaced through the registry.
 * Puck calls this in the editor whenever the block's props change; the
 * resolver returns updated props (and optional `readOnly` flags marking
 * derived fields). We narrow the shape so blocks don't pull Puck's full
 * generic type machinery into the registry contract.
 */
export interface EmailBlockResolveDataParams<P> {
  changed: Partial<Record<keyof P, boolean> & { id: string }>;
  lastData: { props: P } | null;
  trigger: 'insert' | 'replace' | 'load' | 'force' | 'move';
}

export type EmailBlockResolveData<P> = (
  data: { props: P },
  params: EmailBlockResolveDataParams<P>,
) => Promise<{ props?: Partial<P>; readOnly?: Partial<Record<keyof P, boolean>> }>
  | { props?: Partial<P>; readOnly?: Partial<Record<keyof P, boolean>> };

export interface EmailBlockEntry<P extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable id used as templates_block_defs.component_id. Lowercase + dash. */
  componentId: string;
  /** Human-readable label shown in the Puck palette. */
  label: string;
  /** Block category (used by the palette to group entries). */
  category?: string;
  /** Puck field config — same shape as schema-driven blocks build. */
  fields: Record<string, Field>;
  /** Default props when the block is first inserted. */
  defaultProps: P;
  /** TSX component — receives Puck props at render time, returns email-safe JSX. */
  Component: ComponentType<P & { editMode?: boolean }>;
  /**
   * Optional Puck `resolveData` hook. Called in the editor when props
   * change; useful for fetching preview data (weather, currency rates,
   * etc.) so the canvas shows realistic content. Does NOT run at send
   * time — per-recipient personalisation still goes through the
   * Mustache substitution pass in newsletter-send.
   */
  resolveData?: EmailBlockResolveData<P>;
  /**
   * Optional per-format component variants for non-email outputs.
   * When EditionEmail is composed for `format='substack'` (or 'beehiiv')
   * it uses `formats.substack` instead of `Component` for this block.
   * If absent, EditionEmail falls back to `Component` and lets
   * @react-email/render emit a simplified version (or to a plain-text
   * representation when the format adapter requests it).
   *
   * Components — not strings — so a single `await render(<EditionEmail/>)`
   * call composes the whole document across formats. No string concat,
   * no per-block render dance.
   */
  formats?: Partial<Record<FormatId, ComponentType<P>>>;
  /**
   * Optional opt-in for geo/engagement reporting (spec
   * spec-newsletter-geo-engagement-reporting §8.2). Maps a tracked link's
   * 0-based `link_index` (its position among this block's tracked links) to a
   * human label, so per-option reports show real option text (e.g. "Agree" /
   * "Disagree") instead of a generic "Option 1/2". Pure + side-effect-free.
   * Absence is non-fatal — reporting falls back to the block content / index.
   */
  getTrackedLinkLabels?: (props: P) => Record<number, string>;
}

/**
 * The runtime map. Keep insertion-ordered — the palette displays in
 * this order. Defined in `index.ts`.
 */
export type EmailBlockRegistry = ReadonlyMap<string, EmailBlockEntry>;

// Note: an earlier draft exported an `emailBlockToPuckRender` helper
// here. It became redundant once `mergeRegistryIntoConfig` got its own
// `puckEntryFromRegistry` shim — that lives in `merge-into-config.tsx`
// where the JSX belongs.
