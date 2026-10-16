/**
 * Plans the eleven pages of an LFX foundation site as ordered block
 * instances. Mirrors the generator's page renderers (sitegen.js) section
 * for section, so the imported site looks like the zip before anyone
 * edits it.
 *
 * Pure: site.json in, PlannedPage[] out. Data-backed blocks (members,
 * events, news) get their list fields filled later by `fill.ts`.
 */

import type {
  LfxFill,
  LfxSiteJson,
  PlannedBlock,
  PlannedPage,
} from './types.js';
import { LFX_PATHS } from './theme.js';

const P = LFX_PATHS;

const isPlaceholder = (s: unknown): boolean => /\[[^\]"]{1,80}\]/.test(String(s ?? ''));
// Strict: no `?`, `&` or whitespace, so a mailto: built from it carries no parameters.
const isEmail = (s: string): boolean => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(s);
const safeUrl = (u: unknown): string => {
  const s = String(u ?? '').trim();
  return /^(https?:\/\/|mailto:|#|\/)/i.test(s) && !/^\/\//.test(s) ? s : '#';
};

/** `/about/` → `/about`; `/` stays. DB full_path has no trailing slash. */
export function pathForDb(href: string): string {
  if (href === '/') return '/';
  return href.replace(/\/+$/, '');
}

function crumbs(trail: Array<[string, string]>): Array<{ label: string; href: string; current: boolean }> {
  return trail.map(([label, href], i) => ({ label, href, current: i === trail.length - 1 }));
}

function pageHead(
  page: { eyebrow: string; headline: string; intro: string },
  trail: Array<[string, string]>,
): PlannedBlock {
  return {
    key: 'lfx_page_head',
    content: { eyebrow: page.eyebrow, headline: page.headline, intro: page.intro, crumbs: crumbs(trail) },
  };
}

function paragraphsToHtml(text: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('\n');
}

export function planPages(site: LfxSiteJson): PlannedPage[] {
  const pg = site.pages;
  const short = site.project.short || site.project.name;
  const home = pg.home;

  const pages: PlannedPage[] = [];

  // -- Home -----------------------------------------------------------------
  pages.push({
    slug: 'index',
    full_path: '/',
    title: home.seo_title || `${site.project.name}: ${site.project.tagline}`,
    seo: { title: home.seo_title, description: home.seo_description },
    is_homepage: true,
    parent_path: null,
    blocks: [
      {
        key: 'lfx_hero',
        content: {
          eyebrow: home.hero.eyebrow,
          headline: home.hero.headline,
          sub: home.hero.sub,
          primary_label: home.hero.cta_primary,
          primary_href: P.join,
          secondary_label: home.hero.cta_secondary,
          secondary_href: P.about,
          tone: 'dark',
          grid: true,
        },
      },
      {
        key: 'lfx_stats',
        content: { aria_label: 'Key numbers', items: home.stats.map((s) => ({ value: s.value, label: s.label })) },
      },
      {
        key: 'lfx_pillars',
        content: {
          eyebrow: home.pillars_eyebrow,
          title: home.pillars_title,
          mist: true,
          items: home.pillars.map((p, i) => ({
            num: String(i + 1).padStart(2, '0'),
            title: p.title,
            text: p.text,
            points: (p.points ?? []).map((text) => ({ text })),
          })),
        },
      },
      {
        key: 'lfx_member_logos',
        content: {
          eyebrow: 'Members',
          title: home.members_title,
          link_label: 'See all members',
          link_href: P.members,
          members: [],
        },
      },
      {
        key: 'lfx_events_news',
        content: {
          events_eyebrow: 'Events',
          events_title: 'Upcoming',
          events_link_label: 'All events',
          events_link_href: P.events,
          events: [],
          news_eyebrow: 'News',
          news_title: 'Latest',
          news_link_label: 'All news',
          news_link_href: P.blog,
          posts: [],
        },
      },
      {
        key: 'lfx_faq',
        content: { eyebrow: 'FAQ', title: 'Questions', items: home.faq.map((f) => ({ q: f.q, a: f.a })) },
      },
      {
        key: 'lfx_cta_band',
        content: {
          headline: home.cta.headline,
          text: home.cta.text,
          button_label: home.cta.button,
          button_href: P.join,
        },
      },
    ],
  });

  // -- About ----------------------------------------------------------------
  const about = pg.about;
  pages.push({
    slug: 'about',
    full_path: pathForDb(P.about),
    title: about.headline,
    seo: { description: about.seo_description },
    is_homepage: false,
    parent_path: null,
    blocks: [
      pageHead(about, [['Home', P.home], ['About', P.about]]),
      { key: 'lfx_prose', content: { sections: about.sections.map((s) => ({ title: s.title, text: s.text })) } },
      {
        key: 'lfx_card_grid',
        content: {
          title: about.audiences_title,
          mist: true,
          items: about.audiences.map((a) => ({ title: a.title, text: a.text })),
        },
      },
      {
        key: 'lfx_card_grid',
        content: {
          title: 'Governance and community',
          mist: false,
          items: [
            { title: pg.governing_board.headline, href: P.governing_board, meta: '', text: pg.governing_board.intro },
            { title: pg.technical_committee.headline, href: P.technical_committee, meta: '', text: pg.technical_committee.intro },
            { title: pg.members.headline, href: P.members, meta: '', text: pg.members.intro },
            { title: pg.contact.headline, href: P.contact, meta: '', text: pg.contact.intro },
          ],
        },
      },
    ],
  });

  // -- Governing board / Technical committee --------------------------------
  for (const [key, href, label] of [
    ['governing_board', P.governing_board, 'Governing Board'],
    ['technical_committee', P.technical_committee, 'Technical Committee'],
  ] as const) {
    const page = pg[key];
    pages.push({
      slug: key.replace('_', '-'),
      full_path: pathForDb(href),
      title: page.headline,
      seo: { description: page.seo_description },
      is_homepage: false,
      parent_path: pathForDb(P.about),
      blocks: [
        pageHead(page, [['Home', P.home], ['About', P.about], [label, href]]),
        {
          key: 'lfx_people',
          content: {
            people: page.people.map((p) => ({ name: p.name, role: p.role ?? '', title: p.title ?? '', org: p.org ?? '' })),
          },
        },
      ],
    });
  }

  // -- Members --------------------------------------------------------------
  const members = pg.members;
  pages.push({
    slug: 'members',
    full_path: pathForDb(P.members),
    title: members.headline,
    seo: { description: members.seo_description },
    is_homepage: false,
    parent_path: pathForDb(P.about),
    blocks: [
      pageHead(members, [['Home', P.home], ['About', P.about], ['Members', P.members]]),
      {
        key: 'lfx_member_tiers',
        content: {
          tiers: members.tiers.map((t, i) => ({
            name: t.name,
            mist: i % 2 === 1,
            members: t.members.map((name) => ({ name, logo_url: '', website_url: '' })),
          })),
        },
      },
      { key: 'lfx_cta_band', content: { headline: 'Become a member', text: '', button_label: 'Join', button_href: P.join } },
    ],
  });

  // -- Contact --------------------------------------------------------------
  const contact = pg.contact;
  pages.push({
    slug: 'contact',
    full_path: pathForDb(P.contact),
    title: contact.headline,
    seo: { description: contact.seo_description },
    is_homepage: false,
    parent_path: pathForDb(P.about),
    blocks: [
      pageHead(contact, [['Home', P.home], ['About', P.about], ['Contact', P.contact]]),
      {
        key: 'lfx_card_grid',
        content: {
          title: '',
          mist: false,
          items: contact.channels.map((c) => {
            const real = !isPlaceholder(c.value) && isEmail(c.value);
            return real
              ? { title: c.label, text: '', link_label: c.value, link_href: `mailto:${c.value}` }
              : { title: c.label, text: c.value };
          }),
        },
      },
    ],
  });

  // -- Events ---------------------------------------------------------------
  const events = pg.events;
  pages.push({
    slug: 'events',
    full_path: pathForDb(P.events),
    title: events.headline,
    seo: { description: events.seo_description },
    is_homepage: false,
    parent_path: null,
    blocks: [
      pageHead(events, [['Home', P.home], ['Events', P.events]]),
      {
        key: 'lfx_event_list',
        content: {
          events: events.items.map((e) => ({ name: e.name, date: e.date, location: e.location, url: safeUrl(e.url) === '#' ? '' : safeUrl(e.url) })),
        },
      },
    ],
  });

  // -- News -----------------------------------------------------------------
  const blog = pg.blog;
  const newsFill: LfxFill = { fields: { items: { source: 'blog.latest', limit: 12, shape: 'cards' } } };
  pages.push({
    slug: 'news',
    full_path: pathForDb(P.blog),
    title: blog.headline,
    seo: { description: blog.seo_description },
    is_homepage: false,
    parent_path: null,
    blocks: [
      pageHead(blog, [['Home', P.home], ['News', P.blog]]),
      {
        key: 'lfx_card_grid',
        fill: newsFill,
        content: {
          title: '',
          mist: false,
          items: blog.posts.map((p) => ({
            meta: [p.date, p.author].filter(Boolean).join(' · '),
            title: p.title,
            href: safeUrl(p.url) === '#' ? '' : safeUrl(p.url),
            text: p.excerpt ?? '',
          })),
        },
      },
    ],
  });

  // -- Get involved ---------------------------------------------------------
  const gi = pg.get_involved;
  pages.push({
    slug: 'get-involved',
    full_path: pathForDb(P.get_involved),
    title: gi.headline,
    seo: { description: gi.seo_description },
    is_homepage: false,
    parent_path: null,
    blocks: [
      pageHead(gi, [['Home', P.home], ['Get involved', P.get_involved]]),
      {
        key: 'lfx_card_grid',
        content: {
          title: '',
          mist: false,
          items: gi.ways.map((w) => ({ title: w.title, text: w.text, link_label: w.cta, link_href: safeUrl(w.url) })),
        },
      },
    ],
  });

  // -- Join -----------------------------------------------------------------
  const join = pg.join;
  pages.push({
    slug: 'join',
    full_path: pathForDb(P.join),
    title: join.headline,
    seo: { description: join.seo_description },
    is_homepage: false,
    parent_path: null,
    blocks: [
      pageHead(join, [['Home', P.home], ['Join', P.join]]),
      {
        key: 'lfx_membership_tiers',
        content: {
          tiers: join.tiers.map((t) => ({ name: t.name, text: t.text, benefits: (t.benefits ?? []).map((text) => ({ text })) })),
          cta_label: join.cta,
          cta_href: safeUrl(join.cta_url),
        },
      },
    ],
  });

  // -- Campaign -------------------------------------------------------------
  const camp = pg.campaign;
  pages.push({
    slug: 'campaign',
    full_path: pathForDb(P.campaign),
    title: isPlaceholder(camp.headline) ? `${short} campaign` : camp.headline,
    seo: { description: camp.seo_description },
    is_homepage: false,
    parent_path: null,
    blocks: [
      {
        key: 'lfx_hero',
        content: {
          eyebrow: camp.eyebrow,
          headline: camp.headline,
          sub: camp.sub,
          primary_label: camp.cta,
          primary_href: safeUrl(camp.cta_url),
          secondary_label: '',
          secondary_href: '',
          tone: 'dark',
          grid: false,
        },
      },
      { key: 'lfx_rich_text', content: { body: paragraphsToHtml(camp.body) } },
    ],
  });

  return pages;
}
