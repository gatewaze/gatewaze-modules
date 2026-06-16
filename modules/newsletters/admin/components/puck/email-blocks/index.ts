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
import { WeatherBlock } from './blocks/Weather.js';
// Phase A — react.email/components parity, variant fills:
import { HeaderWithNavBlock } from './blocks/HeaderWithNav.js';
import { MultiColumnFooterBlock } from './blocks/MultiColumnFooter.js';
import { SectionWithBackgroundBlock } from './blocks/SectionWithBackground.js';
import { TwoColumnGridBlock } from './blocks/TwoColumnGrid.js';
import { ThreeColumnGridBlock } from './blocks/ThreeColumnGrid.js';
import { LabeledDividerBlock } from './blocks/LabeledDivider.js';
import { HeadingWithEyebrowBlock } from './blocks/HeadingWithEyebrow.js';
import { PullQuoteBlock } from './blocks/PullQuote.js';
import { LinkWithArrowBlock } from './blocks/LinkWithArrow.js';
import { ButtonGroupBlock } from './blocks/ButtonGroup.js';
import { ImageWithCaptionBlock } from './blocks/ImageWithCaption.js';
import { FullWidthImageBlock } from './blocks/FullWidthImage.js';
import { IconListBlock } from './blocks/IconList.js';
// Phase B — Articles, Features, Testimonials, Stats:
import { ArticleCardBlock } from './blocks/ArticleCard.js';
import { ArticleListBlock } from './blocks/ArticleList.js';
import { ArticleWithAuthorBlock } from './blocks/ArticleWithAuthor.js';
import { ArticleWithImageBlock } from './blocks/ArticleWithImage.js';
import { FeaturedArticleBlock } from './blocks/FeaturedArticle.js';
import { CompactArticleBlock } from './blocks/CompactArticle.js';
import { ThreeColumnFeaturesBlock } from './blocks/ThreeColumnFeatures.js';
import { FeatureRowWithIconBlock } from './blocks/FeatureRowWithIcon.js';
import { AlternatingFeaturesBlock } from './blocks/AlternatingFeatures.js';
import { FeatureGridBlock } from './blocks/FeatureGrid.js';
import { TestimonialCardBlock } from './blocks/TestimonialCard.js';
import { TestimonialStackBlock } from './blocks/TestimonialStack.js';
import { StatsThreeUpBlock } from './blocks/StatsThreeUp.js';
import { StatsWithDescriptionBlock } from './blocks/StatsWithDescription.js';
// Phase C — Avatars, Gallery, Pricing, Feedback:
import { AvatarBlock } from './blocks/Avatar.js';
import { AvatarWithNameBlock } from './blocks/AvatarWithName.js';
import { AvatarRowBlock } from './blocks/AvatarRow.js';
import { AvatarWithStatusBlock } from './blocks/AvatarWithStatus.js';
import { GalleryTwoColBlock } from './blocks/GalleryTwoCol.js';
import { GalleryThreeColBlock } from './blocks/GalleryThreeCol.js';
import { GalleryFourColBlock } from './blocks/GalleryFourCol.js';
import { GalleryMosaicBlock } from './blocks/GalleryMosaic.js';
import { PricingCardBlock } from './blocks/PricingCard.js';
import { PricingComparisonBlock } from './blocks/PricingComparison.js';
import { StarRatingBlock } from './blocks/StarRating.js';
import { ThumbsRatingBlock } from './blocks/ThumbsRating.js';
import { ScaleRatingBlock } from './blocks/ScaleRating.js';
// Phase D — Code, Markdown, Ecommerce:
import { CodeInlineBlock } from './blocks/CodeInline.js';
import { CodeInlineWithLabelBlock } from './blocks/CodeInlineWithLabel.js';
import { CodeBlockBlock } from './blocks/CodeBlock.js';
import { CodeBlockWithFilenameBlock } from './blocks/CodeBlockWithFilename.js';
import { CodeBlockWithLineNumbersBlock } from './blocks/CodeBlockWithLineNumbers.js';
import { CodeBlockWithCopyLinkBlock } from './blocks/CodeBlockWithCopyLink.js';
import { MarkdownContentBlock } from './blocks/MarkdownContent.js';
import { MarkdownBlockquoteBlock } from './blocks/MarkdownBlockquote.js';
import { MarkdownChangelogBlock } from './blocks/MarkdownChangelog.js';
import { ProductCardBlock } from './blocks/ProductCard.js';
import { ProductGridBlock } from './blocks/ProductGrid.js';
import { CartSummaryBlock } from './blocks/CartSummary.js';
import { OrderReceiptBlock } from './blocks/OrderReceipt.js';
import { ShippingTrackerBlock } from './blocks/ShippingTracker.js';
import { JobOfWeekBlock } from './blocks/JobOfWeek.js';
import { LastWeeksTakeBlock } from './blocks/LastWeeksTake.js';
import { MlConfessionsBlock } from './blocks/MlConfessions.js';
import { IntroParagraphBlock } from './blocks/IntroParagraph.js';
import { HowWeHelpBlock } from './blocks/HowWeHelp.js';
import { HotTakeBlock } from './blocks/HotTake.js';
import { AgentInfrastructureBlock } from './blocks/AgentInfrastructure.js';
import { GenericBlock } from './blocks/GenericBlock.js';
import { HiddenGemsBlock } from './blocks/HiddenGems.js';
import { SponsoredAdBlock } from './blocks/SponsoredAd.js';
import { MemeOfWeekBlock } from './blocks/MemeOfWeek.js';
import { AiSummaryBlock } from './blocks/AiSummary.js';
import { MlopsCommunityBlock } from './blocks/MlopsCommunity.js';
import { PodcastBlock } from './blocks/Podcast.js';
import { BlogPostBlock } from './blocks/BlogPost.js';
import { ReadingGroupBlock } from './blocks/ReadingGroup.js';
import { GenericSectionBlock } from './blocks/GenericSection.js';

const ENTRIES: ReadonlyArray<EmailBlockEntry> = [
  // Navigation — composites
  LogoHeaderBlock as unknown as EmailBlockEntry,
  HeaderBlock as unknown as EmailBlockEntry,
  HeaderWithNavBlock as unknown as EmailBlockEntry,
  FooterBlock as unknown as EmailBlockEntry,
  MultiColumnFooterBlock as unknown as EmailBlockEntry,
  // Introduction — composites
  HeroBlock as unknown as EmailBlockEntry,
  // Content — composites (Barebone-derived)
  TwoColumnFeaturesBlock as unknown as EmailBlockEntry,
  BulletListBlock as unknown as EmailBlockEntry,
  IconListBlock as unknown as EmailBlockEntry,
  // Content — composites (basic / wizard)
  ContentSectionBlock as unknown as EmailBlockEntry,
  // Content — newsletter (native ports of legacy mustache blocks)
  JobOfWeekBlock as unknown as EmailBlockEntry,
  IntroParagraphBlock as unknown as EmailBlockEntry,
  HotTakeBlock as unknown as EmailBlockEntry,
  LastWeeksTakeBlock as unknown as EmailBlockEntry,
  MlConfessionsBlock as unknown as EmailBlockEntry,
  HowWeHelpBlock as unknown as EmailBlockEntry,
  AiSummaryBlock as unknown as EmailBlockEntry,
  SponsoredAdBlock as unknown as EmailBlockEntry,
  HiddenGemsBlock as unknown as EmailBlockEntry,
  AgentInfrastructureBlock as unknown as EmailBlockEntry,
  GenericBlock as unknown as EmailBlockEntry,
  MemeOfWeekBlock as unknown as EmailBlockEntry,
  // Header/footer chrome is defined by a declarative wrapper template in each
  // newsletter's repo (`wrappers/default.html`, ingested into
  // `templates_wrappers`). `EditionEmail` reads that row and renders the body
  // inside the wrapper's `<slot name="body" />`. The legacy TSX-based
  // NewsletterHeader / NewsletterFooter components were deleted alongside the
  // wrapper.json / collection.config.wrapper / sync-template-config trio.
  // Community — slot container + its bricks
  MlopsCommunityBlock as unknown as EmailBlockEntry,
  PodcastBlock as unknown as EmailBlockEntry,
  BlogPostBlock as unknown as EmailBlockEntry,
  ReadingGroupBlock as unknown as EmailBlockEntry,
  GenericSectionBlock as unknown as EmailBlockEntry,
  HelixAiContentBlock as unknown as EmailBlockEntry,
  // Content — composites (data-driven via Puck resolveData)
  WeatherBlock as unknown as EmailBlockEntry,
  // Articles
  FeaturedArticleBlock as unknown as EmailBlockEntry,
  ArticleCardBlock as unknown as EmailBlockEntry,
  ArticleWithImageBlock as unknown as EmailBlockEntry,
  ArticleWithAuthorBlock as unknown as EmailBlockEntry,
  ArticleListBlock as unknown as EmailBlockEntry,
  CompactArticleBlock as unknown as EmailBlockEntry,
  // Features
  ThreeColumnFeaturesBlock as unknown as EmailBlockEntry,
  FeatureRowWithIconBlock as unknown as EmailBlockEntry,
  AlternatingFeaturesBlock as unknown as EmailBlockEntry,
  FeatureGridBlock as unknown as EmailBlockEntry,
  // Testimonials
  TestimonialCardBlock as unknown as EmailBlockEntry,
  TestimonialStackBlock as unknown as EmailBlockEntry,
  // Stats
  StatsThreeUpBlock as unknown as EmailBlockEntry,
  StatsWithDescriptionBlock as unknown as EmailBlockEntry,
  // Avatars
  AvatarBlock as unknown as EmailBlockEntry,
  AvatarWithNameBlock as unknown as EmailBlockEntry,
  AvatarRowBlock as unknown as EmailBlockEntry,
  AvatarWithStatusBlock as unknown as EmailBlockEntry,
  // Gallery
  GalleryTwoColBlock as unknown as EmailBlockEntry,
  GalleryThreeColBlock as unknown as EmailBlockEntry,
  GalleryFourColBlock as unknown as EmailBlockEntry,
  GalleryMosaicBlock as unknown as EmailBlockEntry,
  // Pricing
  PricingCardBlock as unknown as EmailBlockEntry,
  PricingComparisonBlock as unknown as EmailBlockEntry,
  // Feedback
  StarRatingBlock as unknown as EmailBlockEntry,
  ThumbsRatingBlock as unknown as EmailBlockEntry,
  ScaleRatingBlock as unknown as EmailBlockEntry,
  // Code
  CodeInlineBlock as unknown as EmailBlockEntry,
  CodeInlineWithLabelBlock as unknown as EmailBlockEntry,
  CodeBlockBlock as unknown as EmailBlockEntry,
  CodeBlockWithFilenameBlock as unknown as EmailBlockEntry,
  CodeBlockWithLineNumbersBlock as unknown as EmailBlockEntry,
  CodeBlockWithCopyLinkBlock as unknown as EmailBlockEntry,
  // Markdown
  MarkdownContentBlock as unknown as EmailBlockEntry,
  MarkdownBlockquoteBlock as unknown as EmailBlockEntry,
  MarkdownChangelogBlock as unknown as EmailBlockEntry,
  // Ecommerce
  ProductCardBlock as unknown as EmailBlockEntry,
  ProductGridBlock as unknown as EmailBlockEntry,
  CartSummaryBlock as unknown as EmailBlockEntry,
  OrderReceiptBlock as unknown as EmailBlockEntry,
  ShippingTrackerBlock as unknown as EmailBlockEntry,
  // Content — composites (heading / quote / captioned)
  HeadingWithEyebrowBlock as unknown as EmailBlockEntry,
  PullQuoteBlock as unknown as EmailBlockEntry,
  ImageWithCaptionBlock as unknown as EmailBlockEntry,
  FullWidthImageBlock as unknown as EmailBlockEntry,
  // Content — primitives (leaf)
  HeadingBlock as unknown as EmailBlockEntry,
  TextBlock as unknown as EmailBlockEntry,
  ImgBlock as unknown as EmailBlockEntry,
  LinkBlock as unknown as EmailBlockEntry,
  LinkWithArrowBlock as unknown as EmailBlockEntry,
  // Action — composites + primitives
  CTACardBlock as unknown as EmailBlockEntry,
  ButtonBlock as unknown as EmailBlockEntry,
  ButtonGroupBlock as unknown as EmailBlockEntry,
  // Social — composites
  SocialIconsRowBlock as unknown as EmailBlockEntry,
  // Layout — primitives (slot containers)
  ContainerBlock as unknown as EmailBlockEntry,
  SectionBlock as unknown as EmailBlockEntry,
  SectionWithBackgroundBlock as unknown as EmailBlockEntry,
  RowBlock as unknown as EmailBlockEntry,
  ColumnBlock as unknown as EmailBlockEntry,
  // Layout — grid presets (static fields, not composable slots)
  TwoColumnGridBlock as unknown as EmailBlockEntry,
  ThreeColumnGridBlock as unknown as EmailBlockEntry,
  // Layout — dividers
  HrBlock as unknown as EmailBlockEntry,
  LabeledDividerBlock as unknown as EmailBlockEntry,
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
