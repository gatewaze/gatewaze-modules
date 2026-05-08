/**
 * Email-blocks registry. Per spec-builder-evaluation §3.6 (extended).
 *
 * Single source of truth for `render_kind='react-email'` blocks. The
 * editor's `buildPuckConfig` merges these entries into the Puck Config
 * alongside schema-driven Mustache blocks; the publish-worker resolves
 * `templates_block_defs.component_id` against this same map.
 *
 * Three layers of entries coexist here:
 *
 *   1. **Primitives** — direct wrappers around `@react-email/components`
 *      primitives (Container / Section / Row / Column / Heading / Text /
 *      Button / Img / Link / Hr). Authors compose them from the Puck
 *      drawer to build any layout. Container / Section / Row / Column
 *      declare slot children (`type: 'slot'`) so primitives nest into
 *      a JSX tree the publish-worker walks recursively.
 *
 *   2. **Composites — Basic** — the four blocks the Newsletter Setup
 *      Wizard's Basic Template auto-stamps (Header / ContentSection /
 *      HelixAiContent / Footer).
 *
 *   3. **Composites — Barebone** — six full-section building blocks
 *      derived from the patterns in `gatewaze-template-email/emails/`
 *      (Hero / TwoColumnFeatures / CTACard / BulletList /
 *      SocialIconsRow / LogoHeader). One drop-in block per pattern;
 *      operators compose editions from these without touching
 *      Section + Row + Column primitives unless they want to.
 *
 * Adding a new block:
 *   1. Create `blocks/<Name>.tsx` exporting an EmailBlockEntry.
 *   2. Import + register here.
 *   3. (When ready to ship) insert a `templates_block_defs` row with
 *      render_kind='react-email', component_id='<componentId>'.
 */

import type { EmailBlockEntry, EmailBlockRegistry } from './registry-types.js';
import { HeadingBlock } from './blocks/Heading.js';
import { TextBlock } from './blocks/Text.js';
import { ButtonBlock } from './blocks/Button.js';
import { HeaderBlock } from './blocks/Header.js';
import { ContentSectionBlock } from './blocks/ContentSection.js';
import { HelixAiContentBlock } from './blocks/HelixAiContent.js';
import { FooterBlock } from './blocks/Footer.js';
import { ContainerBlock } from './blocks/Container.js';
import { SectionBlock } from './blocks/SectionPrimitive.js';
import { RowBlock } from './blocks/Row.js';
import { ColumnBlock } from './blocks/Column.js';
import { ImgBlock } from './blocks/Img.js';
import { LinkBlock } from './blocks/Link.js';
import { HrBlock } from './blocks/Hr.js';
import { HeroBlock } from './blocks/Hero.js';
import { TwoColumnFeaturesBlock } from './blocks/TwoColumnFeatures.js';
import { CTACardBlock } from './blocks/CTACard.js';
import { BulletListBlock } from './blocks/BulletList.js';
import { SocialIconsRowBlock } from './blocks/SocialIconsRow.js';
import { LogoHeaderBlock } from './blocks/LogoHeader.js';

const ENTRIES: ReadonlyArray<EmailBlockEntry> = [
  // Navigation — composites
  LogoHeaderBlock as unknown as EmailBlockEntry,
  HeaderBlock as unknown as EmailBlockEntry,
  FooterBlock as unknown as EmailBlockEntry,
  // Introduction — composites
  HeroBlock as unknown as EmailBlockEntry,
  // Content — composites (Barebone-derived)
  TwoColumnFeaturesBlock as unknown as EmailBlockEntry,
  BulletListBlock as unknown as EmailBlockEntry,
  // Content — composites (basic / wizard)
  ContentSectionBlock as unknown as EmailBlockEntry,
  HelixAiContentBlock as unknown as EmailBlockEntry,
  // Content — primitives (leaf)
  HeadingBlock as unknown as EmailBlockEntry,
  TextBlock as unknown as EmailBlockEntry,
  ImgBlock as unknown as EmailBlockEntry,
  LinkBlock as unknown as EmailBlockEntry,
  // Action — composites + primitives
  CTACardBlock as unknown as EmailBlockEntry,
  ButtonBlock as unknown as EmailBlockEntry,
  // Social — composites
  SocialIconsRowBlock as unknown as EmailBlockEntry,
  // Layout — primitives (slot containers)
  ContainerBlock as unknown as EmailBlockEntry,
  SectionBlock as unknown as EmailBlockEntry,
  RowBlock as unknown as EmailBlockEntry,
  ColumnBlock as unknown as EmailBlockEntry,
  HrBlock as unknown as EmailBlockEntry,
];

const map = new Map<string, EmailBlockEntry>();
for (const e of ENTRIES) {
  if (map.has(e.componentId)) {
    throw new Error(`Duplicate email-block componentId: ${e.componentId}`);
  }
  map.set(e.componentId, e);
}

export const emailBlockRegistry: EmailBlockRegistry = map;

export function getEmailBlock(componentId: string): EmailBlockEntry | undefined {
  return map.get(componentId);
}

export type { EmailBlockEntry, EmailBlockRegistry, FormatId } from './registry-types.js';
