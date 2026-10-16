/**
 * Types for the LFX website-builder import.
 *
 * Paul's Marketing OS agents (`lfx-mos-website`) generate a static
 * foundation site from a brand kit. The zip they produce carries
 * `site.json` — every field of copy per page plus the brand tokens —
 * alongside the rendered HTML, `assets/site.css`, `assets/site.js` and
 * the recoloured logo SVGs. This module turns that bundle into a
 * gatewaze site: a templates library (wrapper + blocks), blocks-mode
 * pages, and page_blocks rows the Puck canvas can edit.
 *
 * Only the fields the importer reads are typed here; the generator adds
 * more (voice, audit) which we carry through untouched in
 * `sites.config.lfx`.
 */

export interface LfxProject {
  name: string;
  short: string;
  domain: string;
  tagline: string;
  description: string;
  legal: string;
}

export interface LfxBrand {
  dark: string;
  accent: string;
  spark?: string;
  font?: string;
  fontNote?: string;
  colors?: Array<[string, string, string]>;
  logo_light?: string;
  logo_dark?: string;
  symbol?: string;
  logo_file?: string;
}

export interface LfxSignup {
  headline: string;
  text: string;
  button: string;
  consent: string;
  endpoint: string;
}

export interface LfxHomePage {
  seo_title?: string;
  seo_description?: string;
  hero: { eyebrow: string; headline: string; sub: string; cta_primary: string; cta_secondary: string };
  pillars_eyebrow: string;
  pillars_title: string;
  pillars: Array<{ title: string; text: string; points?: string[] }>;
  stats: Array<{ value: string; label: string }>;
  members_title: string;
  cta: { headline: string; text: string; button: string };
  faq: Array<{ q: string; a: string }>;
}

export interface LfxHeadedPage {
  seo_description?: string;
  eyebrow: string;
  headline: string;
  intro: string;
}

export interface LfxAboutPage extends LfxHeadedPage {
  sections: Array<{ title: string; text: string }>;
  audiences_title: string;
  audiences: Array<{ title: string; text: string }>;
}

export interface LfxPerson {
  name: string;
  role?: string;
  title?: string;
  org?: string;
}

export interface LfxPeoplePage extends LfxHeadedPage {
  people: LfxPerson[];
  charter_url?: string;
}

export interface LfxMembersPage extends LfxHeadedPage {
  tiers: Array<{ name: string; members: string[] }>;
}

export interface LfxContactPage extends LfxHeadedPage {
  channels: Array<{ label: string; value: string }>;
}

export interface LfxEventsPage extends LfxHeadedPage {
  items: Array<{ name: string; date: string; location: string; url?: string }>;
}

export interface LfxBlogPage extends LfxHeadedPage {
  posts: Array<{ title: string; date: string; author?: string; excerpt?: string; url?: string }>;
}

export interface LfxGetInvolvedPage extends LfxHeadedPage {
  ways: Array<{ title: string; text: string; cta: string; url: string }>;
}

export interface LfxJoinPage extends LfxHeadedPage {
  tiers: Array<{ name: string; text: string; benefits?: string[] }>;
  cta: string;
  cta_url: string;
}

export interface LfxCampaignPage {
  seo_description?: string;
  eyebrow: string;
  headline: string;
  sub: string;
  body: string;
  cta: string;
  cta_url: string;
}

export interface LfxPages {
  home: LfxHomePage;
  about: LfxAboutPage;
  governing_board: LfxPeoplePage;
  technical_committee: LfxPeoplePage;
  members: LfxMembersPage;
  contact: LfxContactPage;
  events: LfxEventsPage;
  blog: LfxBlogPage;
  get_involved: LfxGetInvolvedPage;
  join: LfxJoinPage;
  campaign: LfxCampaignPage;
}

export interface LfxSiteJson {
  version: number;
  project: LfxProject;
  brand: LfxBrand;
  social?: Record<string, string>;
  signup: LfxSignup;
  announcement?: { text: string; link: string };
  pages: LfxPages;
  voice?: unknown;
  meta?: Record<string, unknown>;
}

/** The files the importer needs out of the generated zip. */
export interface LfxBundle {
  site: LfxSiteJson;
  /** `assets/site.css` — brand tokens already WCAG-adjusted by the generator. Sanitised on use. */
  css: string;
  /**
   * `assets/site.js`, kept for reference only. It is never embedded: the
   * wrapper ships a first-party copy of the same behaviour (LFX_SITE_JS).
   */
  js?: string;
  logos: {
    /** `assets/logo.svg` (for light grounds). */
    light?: string;
    /** `assets/logo-reversed.svg` (for the dark footer). */
    reversed?: string;
    /** `assets/favicon.svg`. */
    favicon?: string;
  };
}

/** One block to create on a page, in order. */
export interface PlannedBlock {
  key: string;
  content: Record<string, unknown>;
  /**
   * Per-instance data fill. Overrides the block_def's DATA_SOURCE params
   * so a generic block (e.g. the card grid) can be data-backed on one
   * page and static on another.
   */
  fill?: LfxFill;
}

export interface PlannedPage {
  /** Page slug; `index` for the homepage. */
  slug: string;
  full_path: string;
  title: string;
  seo: { title?: string; description?: string };
  is_homepage: boolean;
  /** full_path of the parent page, when nested (for parent_page_id). */
  parent_path: string | null;
  blocks: PlannedBlock[];
}

// ---------------------------------------------------------------------------
// Data fill — how a block's list fields get populated from the platform
// ---------------------------------------------------------------------------

export type LfxFieldSource =
  | { source: 'membership.members'; limit?: number; tiers?: string[] }
  | { source: 'membership.tiers' }
  | { source: 'events.upcoming'; limit?: number }
  | { source: 'blog.latest'; limit?: number; shape?: 'posts' | 'cards' };

/**
 * `fields` maps a content field name to the source that fills it. Stored
 * on the block_def as `data_source.params` (via the DATA_SOURCE marker)
 * and/or on the page_blocks row as `kind_config.fill`.
 */
export interface LfxFill {
  fields: Record<string, LfxFieldSource>;
}

export interface LfxMemberRow {
  name: string;
  tier: string;
  tier_label: string;
  logo_url: string;
  website_url: string;
}

export interface LfxTierGroup {
  name: string;
  mist: boolean;
  members: Array<{ name: string; logo_url: string; website_url: string }>;
}

export interface LfxEventRow {
  name: string;
  date: string;
  location: string;
  url: string;
}

export interface LfxPostRow {
  title: string;
  date: string;
  author: string;
  excerpt: string;
  url: string;
}

/** Platform-side data access. The Supabase implementation lives in data-supabase.ts. */
export interface LfxDataProvider {
  members(opts: { limit?: number; tiers?: string[] }): Promise<LfxMemberRow[]>;
  memberTiers(): Promise<LfxTierGroup[]>;
  upcomingEvents(limit: number): Promise<LfxEventRow[]>;
  latestPosts(limit: number): Promise<LfxPostRow[]>;
}
