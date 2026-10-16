/**
 * Builds the `source.html` for an LFX foundation site: one WRAPPER (the
 * site chrome — LF bar, header + nav, cookie bar, newsletter sign-up,
 * footer) plus the section BLOCKs the generated pages are made of.
 *
 * The output goes through the templates module's marker parser and the
 * canvas template validator unchanged, so every block here must:
 *   - carry `data-block-root` on exactly one element
 *   - contain no <script>
 *   - use `{{{raw}}}` only on fields declared `format: "html"`
 *   - keep array fields as arrays of OBJECTS (Puck's array field has no
 *     scalar-item mode; see json-schema-to-puck-fields.ts)
 *
 * The brand CSS is the generator's `assets/site.css` verbatim — it already
 * carries the WCAG-adjusted tokens — so a rebuild of the brand kit means a
 * re-import, not a hand edit here.
 */

import type { LfxBundle, LfxSiteJson } from './types.js';

export const LFX_WRAPPER_KEY = 'lfx_default';

export const LFX_BLOCK_KEYS = [
  'lfx_hero',
  'lfx_stats',
  'lfx_pillars',
  'lfx_member_logos',
  'lfx_events_news',
  'lfx_faq',
  'lfx_cta_band',
  'lfx_page_head',
  'lfx_prose',
  'lfx_card_grid',
  'lfx_people',
  'lfx_member_tiers',
  'lfx_event_list',
  'lfx_membership_tiers',
  'lfx_rich_text',
] as const;

export type LfxBlockKey = (typeof LFX_BLOCK_KEYS)[number];

/** Site-relative hrefs for the eleven generated pages. */
export const LFX_PATHS = {
  home: '/',
  about: '/about/',
  governing_board: '/about/governing-board/',
  technical_committee: '/about/technical-committee/',
  members: '/about/members/',
  contact: '/about/contact/',
  events: '/events/',
  blog: '/news/',
  get_involved: '/get-involved/',
  join: '/join/',
  campaign: '/campaign/',
} as const;

/**
 * HTML-escape a site.json string for the wrapper. Also neutralises `{{`
 * so bundle copy can never be read as a mustache tag by the renderer.
 */
const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
    .replace(/\{\{/g, '{&#123;');

/** http(s), mailto, in-page anchors and site paths only; anything else becomes '#'. */
const safeUrl = (u: unknown): string => {
  const s = String(u ?? '').trim();
  return /^(https?:\/\/|mailto:|#|\/)/i.test(s) && !/^\/\//.test(s) ? s : '#';
};

/** https only — used where the bundle names a server that will receive visitor data. */
const httpsOnly = (u: unknown): string => {
  const s = String(u ?? '').trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
};

export const svgDataUri = (svg: string): string =>
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

/**
 * The bundle's stylesheet is untrusted input. Keep the brand rules, drop
 * anything that could break out of the <style> block, load from or talk to
 * a third party, or be read as a mustache tag or a marker comment.
 */
export function sanitiseCss(css: string): string {
  return css
    .replace(/<\/style/gi, '')
    .replace(/<!--|-->/g, '')
    .replace(/@import\b[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, '')
    // url() may only point at data: URIs or site-relative paths.
    .replace(/url\(\s*(['"]?)(?!data:|\/(?!\/)|\.\.?\/)[^)]*\1\s*\)/gi, 'url()')
    .replace(/\{\{/g, '{ {');
}

/**
 * Progressive behaviour for the chrome: menu toggle, About sub-menu,
 * cookie choice (stored as `lf-cookie-choice`) and the sign-up form status.
 * A first-party copy of what the generator ships; the bundle's own
 * `assets/site.js` is never embedded, because it would run on the admin
 * origin inside the canvas preview.
 */
export const LFX_SITE_JS = `(function(){"use strict";var d=document,h=d.documentElement;h.className=h.className.replace(/\\bno-js\\b/,"js");
function store(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v)}catch(e){return null}}
var t=d.querySelector(".menu-toggle");function setMenu(o){if(t)t.setAttribute("aria-expanded",o?"true":"false")}
if(t)t.addEventListener("click",function(){setMenu(t.getAttribute("aria-expanded")!=="true")});
var subs=[].slice.call(d.querySelectorAll(".sub-toggle"));function closeSubs(){subs.forEach(function(b){b.setAttribute("aria-expanded","false")})}
subs.forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();var o=b.getAttribute("aria-expanded")!=="true";closeSubs();b.setAttribute("aria-expanded",o?"true":"false")})});
d.addEventListener("click",function(e){if(!e.target.closest||!e.target.closest(".has-sub"))closeSubs()});
d.addEventListener("focusin",function(e){subs.forEach(function(b){var li=b.parentNode;if(li&&!li.contains(e.target))b.setAttribute("aria-expanded","false")})});
d.addEventListener("keydown",function(e){if(e.key!=="Escape")return;var o=subs.filter(function(b){return b.getAttribute("aria-expanded")==="true"})[0];
if(o){closeSubs();o.focus()}else if(t&&t.getAttribute("aria-expanded")==="true"){setMenu(false);t.focus()}});
var c=d.getElementById("cookie");if(c){var k="lf-cookie-choice";if(!store(k))c.hidden=false;c.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-consent]");if(!b)return;
store(k,b.getAttribute("data-consent"));c.hidden=true;var m=d.getElementById("main");if(m){m.setAttribute("tabindex","-1");m.focus()}})}
[].forEach.call(d.querySelectorAll("form.lf-signup"),function(f){f.addEventListener("submit",function(e){var s=f.querySelector(".form-status");
if(!f.getAttribute("data-endpoint")){e.preventDefault();if(s)s.textContent="Sign-up isn't connected yet: wire this form to the LFX form endpoint before launch."}})});
})();`;

function googleFontHref(font: string | undefined): string | null {
  const f = (font ?? '').trim();
  if (!f) return null;
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;500;600;700&display=swap`;
}

/** Extra rules the generator doesn't need (its logo slots are placeholders). */
const EXTRA_CSS = `
.logo-slot.has-logo{border-style:solid;border-color:var(--hair);padding:10px}
.logo-slot img{max-height:44px;max-width:140px;width:auto;height:auto;display:block}
.logo-slot a{display:flex;align-items:center;justify-content:center;width:100%;height:100%}
`;

export function buildWrapperHtml(bundle: LfxBundle): string {
  const { site, css, logos } = bundle;
  const p = site.project;
  const signupEndpoint = httpsOnly(site.signup.endpoint);
  const name = esc(p.name);
  const fontHref = googleFontHref(site.brand.font);
  const favicon = logos.favicon ? svgDataUri(logos.favicon) : null;
  const logoLight = logos.light ? svgDataUri(logos.light) : null;
  const logoDark = logos.reversed ? svgDataUri(logos.reversed) : logoLight;
  const P = LFX_PATHS;

  const brandLink = (src: string | null) =>
    src
      ? `<a class="brand" href="${P.home}"><img src="${src}" alt="${name} home" height="40"></a>`
      : `<a class="brand" href="${P.home}">${name}</a>`;

  const announceHref = site.announcement?.link ? safeUrl(site.announcement.link) : '#';
  const announcement = site.announcement?.text
    ? `<div class="announce">${announceHref !== '#' ? `<a href="${esc(announceHref)}">${esc(site.announcement.text)}</a>` : esc(site.announcement.text)}</div>`
    : '';

  return `<!doctype html>
<html lang="en" class="no-js"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{page.title}}</title>
<meta name="theme-color" content="${esc(site.brand.dark)}">
${favicon ? `<link rel="icon" href="${favicon}" type="image/svg+xml">` : ''}
${fontHref ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${fontHref}">` : ''}
<style>
${sanitiseCss(css)}
${EXTRA_CSS}
</style>
</head>
<body><a class="skip" href="#main">Skip to content</a><section class="cookie" id="cookie" aria-label="Cookie choices" hidden><div class="wrap"><p>We use cookies to understand how the site is used. Analytics stay off until you choose. <a href="https://www.linuxfoundation.org/legal/privacy-policy">Privacy policy</a></p>
<div class="cookie-actions"><button type="button" class="btn alt" data-consent="reject">Reject all</button><button type="button" class="btn" data-consent="accept">Accept all</button></div></div></section>
<div class="lfbar"><div class="wrap"><a href="https://www.linuxfoundation.org/projects">The Linux Foundation</a> Projects</div></div>
${announcement}
<header class="site"><div class="wrap">${brandLink(logoLight)}
<nav class="main" aria-label="Main"><button type="button" class="menu-toggle" aria-expanded="false" aria-controls="menu"><span class="bars" aria-hidden="true"></span>Menu</button>
<ul class="menu" id="menu"><li class="has-sub"><a href="${P.about}">About</a><button type="button" class="sub-toggle" aria-expanded="false" aria-controls="sub-about"><span class="sr-only">About pages</span></button><ul class="sub" id="sub-about"><li><a href="${P.governing_board}">Governing Board</a></li><li><a href="${P.technical_committee}">Technical Committee</a></li><li><a href="${P.members}">Members</a></li><li><a href="${P.contact}">Contact</a></li></ul></li><li><a href="${P.get_involved}">Get involved</a></li><li><a href="${P.events}">Events</a></li><li><a href="${P.blog}">News</a></li><li class="cta"><a class="btn" href="${P.join}">Join</a></li></ul></nav></div></header>
<main id="main">
{{content}}
</main>
<section class="signup" id="signup" aria-labelledby="signup-h"><div class="wrap"><div><h2 id="signup-h">${esc(site.signup.headline)}</h2><p>${esc(site.signup.text)}</p></div>
<form class="lf-signup" data-endpoint="${esc(signupEndpoint)}" action="${signupEndpoint ? esc(signupEndpoint) : '#'}" method="post">
<div><label for="su-email">Work email</label><div class="row2"><input type="email" id="su-email" name="email" required autocomplete="email" placeholder="you@company.com"><button class="btn" type="submit">${esc(site.signup.button)}</button></div></div>
<div class="consent"><input type="checkbox" id="su-consent" name="consent" required><label for="su-consent">${esc(site.signup.consent)}</label></div>
<p class="fine">See the <a href="https://www.linuxfoundation.org/legal/privacy-policy">Linux Foundation Privacy Policy</a>.</p>
<input type="hidden" name="interest" value="${esc(slugify(p.name))}"><input type="hidden" name="source" value="website"><p class="form-status" role="status"></p></form></div></section>
<footer class="site"><div class="wrap"><div class="cols"><div>${brandLink(logoDark)}<p class="tag">${esc(p.tagline)}</p></div>
<div><h2>About</h2><ul><li><a href="${P.about}">About</a></li><li><a href="${P.governing_board}">Governing Board</a></li><li><a href="${P.technical_committee}">Technical Committee</a></li><li><a href="${P.members}">Members</a></li><li><a href="${P.contact}">Contact</a></li></ul></div><div><h2>Community</h2><ul><li><a href="${P.get_involved}">Get involved</a></li><li><a href="${P.events}">Events</a></li><li><a href="${P.blog}">News</a></li><li><a href="${P.join}">Join</a></li></ul></div>
<div><h2>Connect</h2><ul><li><a href="#signup">Newsletter</a></li>${socialLinks(site)}</ul></div></div>
<div class="legal"><p>${esc(p.legal)}</p><p><a href="https://www.linuxfoundation.org/legal/trademark-usage">Trademarks</a> · <a href="https://www.linuxfoundation.org/legal/privacy-policy">Privacy</a> · <a href="https://www.linuxfoundation.org/legal/terms">Terms</a></p></div></div></footer>
<script>${LFX_SITE_JS}</script>
</body></html>`;
}

function socialLinks(site: LfxSiteJson): string {
  const s = site.social ?? {};
  const labels: Record<string, string> = { github: 'GitHub', linkedin: 'LinkedIn', x: 'X', slack: 'Slack' };
  return Object.entries(s)
    .filter(([, url]) => typeof url === 'string' && /^https?:\/\//i.test(url))
    .map(([k, url]) => `<li><a href="${esc(url)}">${esc(labels[k] ?? k)}</a></li>`)
    .join('');
}

export function slugify(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

interface BlockSpec {
  key: LfxBlockKey;
  name: string;
  description: string;
  schema: Record<string, unknown>;
  html: string;
  /** Default data fill for data-backed blocks (stored as DATA_SOURCE). */
  fill?: Record<string, unknown>;
}

const str = (title: string, extra: Record<string, unknown> = {}) => ({ type: 'string', title, ...extra });
const textarea = (title: string) => ({ type: 'string', format: 'textarea', title });
const bool = (title: string, def = false) => ({ type: 'boolean', title, default: def });
const arr = (title: string, properties: Record<string, unknown>) => ({
  type: 'array',
  title,
  items: { type: 'object', properties },
});

const LOGO_ITEM = {
  name: str('Name'),
  logo_url: str('Logo URL'),
  website_url: str('Website'),
};

const LOGO_LI =
  `<li class="logo-slot {{#logo_url}}has-logo{{/logo_url}}">{{#logo_url}}<a href="{{website_url}}"><img src="{{logo_url}}" alt="{{name}}" loading="lazy"></a>{{/logo_url}}{{^logo_url}}{{name}}{{/logo_url}}</li>`;

const EVENT_ROW =
  `<li class="row"><div><h3 style="font-size:1.15rem;margin:0">{{#url}}<a href="{{url}}">{{name}}</a>{{/url}}{{^url}}{{name}}{{/url}}</h3><p class="meta" style="margin:0">{{date}} · {{location}}</p></div></li>`;

export const LFX_BLOCKS: ReadonlyArray<BlockSpec> = [
  {
    key: 'lfx_hero',
    name: 'Hero',
    description: 'Eyebrow, headline, lede and up to two calls to action on a dark or light ground',
    schema: {
      type: 'object',
      properties: {
        eyebrow: str('Eyebrow'),
        headline: str('Headline'),
        sub: textarea('Lede'),
        primary_label: str('Primary button label'),
        primary_href: str('Primary button link'),
        secondary_label: str('Secondary button label'),
        secondary_href: str('Secondary button link'),
        tone: { type: 'string', enum: ['dark', 'light'], default: 'dark', title: 'Tone' },
        grid: bool('Show grid texture', true),
      },
      required: ['headline'],
    },
    html: `<section class="hero {{tone}}" data-block-root><div class="{{#grid}}hero-grid{{/grid}}"><div class="wrap">{{#eyebrow}}<p class="eyebrow">{{eyebrow}}</p>{{/eyebrow}}
<h1>{{headline}}</h1>{{#sub}}<p class="lede">{{sub}}</p>{{/sub}}
<div class="ctas">{{#primary_label}}<a class="btn" href="{{primary_href}}">{{primary_label}}</a>{{/primary_label}}{{#secondary_label}}<a class="btn alt" href="{{secondary_href}}">{{secondary_label}}</a>{{/secondary_label}}</div></div></div></section>`,
  },
  {
    key: 'lfx_stats',
    name: 'Key numbers',
    description: 'A row of big numbers with labels',
    schema: {
      type: 'object',
      properties: {
        aria_label: str('Accessible label', { default: 'Key numbers' }),
        items: arr('Numbers', { value: str('Value'), label: str('Label') }),
      },
    },
    html: `<section class="band" aria-label="{{aria_label}}" data-block-root><div class="wrap"><ul class="stats" style="list-style:none;padding:0;margin:0">{{#items}}<li class="stat"><b>{{value}}</b><span>{{label}}</span></li>{{/items}}</ul></div></section>`,
  },
  {
    key: 'lfx_pillars',
    name: 'Pillars',
    description: 'Numbered cards: what the foundation does',
    schema: {
      type: 'object',
      properties: {
        eyebrow: str('Eyebrow'),
        title: str('Title'),
        mist: bool('Light grey ground', true),
        items: arr('Pillars', {
          num: str('Number'),
          title: str('Title'),
          text: textarea('Text'),
          points: arr('Points', { text: str('Point') }),
        }),
      },
    },
    html: `<section class="band {{#mist}}mist{{/mist}}" aria-labelledby="h-pillars" data-block-root><div class="wrap"><p class="eyebrow">{{eyebrow}}</p><h2 id="h-pillars">{{title}}</h2><ul class="grid" style="margin-top:24px;list-style:none;padding:0">{{#items}}<li class="card pillar"><p class="num" aria-hidden="true">{{num}}</p><h3>{{title}}</h3><p>{{text}}</p><ul class="points">{{#points}}<li>{{text}}</li>{{/points}}</ul></li>{{/items}}</ul></div></section>`,
  },
  {
    key: 'lfx_member_logos',
    name: 'Member logos',
    description: 'Logo grid of member organisations. Filled from the membership module at publish time.',
    schema: {
      type: 'object',
      properties: {
        eyebrow: str('Eyebrow'),
        title: str('Title'),
        link_label: str('Link label'),
        link_href: str('Link'),
        members: arr('Members (filled from membership data at publish)', LOGO_ITEM),
      },
    },
    fill: { fields: { members: { source: 'membership.members', limit: 16, tiers: ['platinum', 'gold'] } } },
    html: `<section class="band" aria-labelledby="h-members" data-block-root><div class="wrap"><p class="eyebrow">{{eyebrow}}</p><h2 id="h-members">{{title}}</h2><ul class="logos">{{#members}}${LOGO_LI}{{/members}}</ul>{{#link_label}}<p style="margin-top:18px"><a href="{{link_href}}">{{link_label}}</a></p>{{/link_label}}</div></section>`,
  },
  {
    key: 'lfx_events_news',
    name: 'Events and news',
    description: 'Two columns: upcoming events and latest news. Filled from the events and blog modules at publish time.',
    schema: {
      type: 'object',
      properties: {
        events_eyebrow: str('Events eyebrow'),
        events_title: str('Events title'),
        events_link_label: str('Events link label'),
        events_link_href: str('Events link'),
        events: arr('Events (filled from events data at publish)', {
          name: str('Name'), date: str('Date'), location: str('Location'), url: str('Link'),
        }),
        news_eyebrow: str('News eyebrow'),
        news_title: str('News title'),
        news_link_label: str('News link label'),
        news_link_href: str('News link'),
        posts: arr('Posts (filled from blog data at publish)', {
          title: str('Title'), date: str('Date'), excerpt: textarea('Summary'), url: str('Link'),
        }),
      },
    },
    fill: { fields: { events: { source: 'events.upcoming', limit: 3 }, posts: { source: 'blog.latest', limit: 3 } } },
    html: `<section class="band mist" aria-label="Events and news" data-block-root><div class="wrap grid"><div><p class="eyebrow">{{events_eyebrow}}</p><h2>{{events_title}}</h2><ul class="list">{{#events}}${EVENT_ROW}{{/events}}{{^events}}<li class="row"><p class="meta" style="margin:0">No upcoming events yet.</p></li>{{/events}}</ul><p style="margin-top:16px"><a href="{{events_link_href}}">{{events_link_label}}</a></p></div>
<div><p class="eyebrow">{{news_eyebrow}}</p><h2>{{news_title}}</h2><ul style="list-style:none;padding:0;margin:0">{{#posts}}<li class="card" style="margin-bottom:12px"><p class="meta">{{date}}</p><h3>{{#url}}<a href="{{url}}">{{title}}</a>{{/url}}{{^url}}{{title}}{{/url}}</h3><p>{{excerpt}}</p></li>{{/posts}}</ul><p><a href="{{news_link_href}}">{{news_link_label}}</a></p></div></div></section>`,
  },
  {
    key: 'lfx_faq',
    name: 'FAQ',
    description: 'Expandable questions and answers',
    schema: {
      type: 'object',
      properties: {
        eyebrow: str('Eyebrow'),
        title: str('Title'),
        items: arr('Questions', { q: str('Question'), a: textarea('Answer') }),
      },
    },
    html: `<section class="band" aria-labelledby="h-faq" data-block-root><div class="wrap faq"><p class="eyebrow">{{eyebrow}}</p><h2 id="h-faq">{{title}}</h2>{{#items}}<details><summary>{{q}}</summary><p>{{a}}</p></details>{{/items}}</div></section>`,
  },
  {
    key: 'lfx_cta_band',
    name: 'Call-to-action band',
    description: 'Dark band with a headline, optional text and one button',
    schema: {
      type: 'object',
      properties: {
        headline: str('Headline'),
        text: textarea('Text'),
        button_label: str('Button label'),
        button_href: str('Button link'),
      },
      required: ['headline', 'button_label'],
    },
    html: `<section class="band" aria-labelledby="h-cta" data-block-root><div class="wrap"><div class="cta-band"><div><h2 id="h-cta">{{headline}}</h2>{{#text}}<p>{{text}}</p>{{/text}}</div><a class="btn" href="{{button_href}}">{{button_label}}</a></div></div></section>`,
  },
  {
    key: 'lfx_page_head',
    name: 'Page head',
    description: 'Breadcrumb, eyebrow, page title and intro on a light grey ground',
    schema: {
      type: 'object',
      properties: {
        eyebrow: str('Eyebrow'),
        headline: str('Headline'),
        intro: textarea('Intro'),
        crumbs: arr('Breadcrumb', { label: str('Label'), href: str('Link'), current: bool('Current page') }),
      },
      required: ['headline'],
    },
    html: `<section class="page-head" data-block-root><div class="wrap"><nav class="crumbs" aria-label="Breadcrumb"><ol>{{#crumbs}}<li><a href="{{href}}"{{#current}} aria-current="page"{{/current}}>{{label}}</a></li>{{/crumbs}}</ol></nav>{{#eyebrow}}<p class="eyebrow">{{eyebrow}}</p>{{/eyebrow}}<h1>{{headline}}</h1>{{#intro}}<p>{{intro}}</p>{{/intro}}</div></section>`,
  },
  {
    key: 'lfx_prose',
    name: 'Prose sections',
    description: 'Titled paragraphs in a readable measure',
    schema: {
      type: 'object',
      properties: {
        sections: arr('Sections', { title: str('Title'), text: textarea('Text') }),
      },
    },
    html: `<section class="band" data-block-root><div class="wrap prose">{{#sections}}<h2>{{title}}</h2><p>{{text}}</p>{{/sections}}</div></section>`,
  },
  {
    key: 'lfx_card_grid',
    name: 'Card grid',
    description: 'Grid of cards with optional meta line, link and text',
    schema: {
      type: 'object',
      properties: {
        title: str('Title'),
        mist: bool('Light grey ground'),
        items: arr('Cards', {
          meta: str('Meta line'),
          title: str('Title'),
          href: str('Title link'),
          text: textarea('Text'),
          link_label: str('Link label'),
          link_href: str('Link'),
        }),
      },
    },
    html: `<section class="band {{#mist}}mist{{/mist}}" data-block-root><div class="wrap">{{#title}}<h2>{{title}}</h2>{{/title}}<ul class="grid" style="margin-top:20px;list-style:none;padding:0">{{#items}}<li class="card">{{#meta}}<p class="meta">{{meta}}</p>{{/meta}}<h3>{{#href}}<a href="{{href}}">{{title}}</a>{{/href}}{{^href}}{{title}}{{/href}}</h3>{{#text}}<p>{{text}}</p>{{/text}}{{#link_label}}<a href="{{link_href}}">{{link_label}}</a>{{/link_label}}</li>{{/items}}</ul></div></section>`,
  },
  {
    key: 'lfx_people',
    name: 'People',
    description: 'Board or committee members',
    schema: {
      type: 'object',
      properties: {
        people: arr('People', { name: str('Name'), role: str('Role'), title: str('Title'), org: str('Organisation') }),
      },
    },
    html: `<section class="band" data-block-root><div class="wrap"><ul class="people">{{#people}}<li class="person"><div class="avatar" aria-hidden="true"></div>{{#role}}<p class="role">{{role}}</p>{{/role}}<h2>{{name}}</h2>{{#title}}<p>{{title}}</p>{{/title}}{{#org}}<p>{{org}}</p>{{/org}}</li>{{/people}}</ul></div></section>`,
  },
  {
    key: 'lfx_member_tiers',
    name: 'Members by tier',
    description: 'One logo band per membership tier. Filled from the membership module at publish time.',
    schema: {
      type: 'object',
      properties: {
        tiers: arr('Tiers (filled from membership data at publish)', {
          name: str('Tier'),
          mist: bool('Light grey ground'),
          members: arr('Members', LOGO_ITEM),
        }),
      },
    },
    fill: { fields: { tiers: { source: 'membership.tiers' } } },
    html: `<div data-block-root>{{#tiers}}<section class="band {{#mist}}mist{{/mist}}"><div class="wrap"><h2>{{name}} members</h2><ul class="logos">{{#members}}${LOGO_LI}{{/members}}</ul></div></section>{{/tiers}}</div>`,
  },
  {
    key: 'lfx_event_list',
    name: 'Event list',
    description: 'Upcoming events as rows. Filled from the events module at publish time.',
    schema: {
      type: 'object',
      properties: {
        events: arr('Events (filled from events data at publish)', {
          name: str('Name'), date: str('Date'), location: str('Location'), url: str('Link'),
        }),
      },
    },
    fill: { fields: { events: { source: 'events.upcoming', limit: 20 } } },
    html: `<section class="band" data-block-root><div class="wrap"><ul class="list">{{#events}}${EVENT_ROW}{{/events}}{{^events}}<li class="row"><p class="meta" style="margin:0">No upcoming events yet.</p></li>{{/events}}</ul></div></section>`,
  },
  {
    key: 'lfx_membership_tiers',
    name: 'Membership tiers',
    description: 'Tier cards with benefits and a join button',
    schema: {
      type: 'object',
      properties: {
        tiers: arr('Tiers', {
          name: str('Tier'),
          text: textarea('Summary'),
          benefits: arr('Benefits', { text: str('Benefit') }),
        }),
        cta_label: str('Button label'),
        cta_href: str('Button link'),
      },
    },
    html: `<section class="band" data-block-root><div class="wrap"><ul class="grid" style="list-style:none;padding:0;margin:0">{{#tiers}}<li class="card tier"><h2 style="font-size:1.35rem">{{name}}</h2><p>{{text}}</p><ul>{{#benefits}}<li>{{text}}</li>{{/benefits}}</ul></li>{{/tiers}}</ul>
{{#cta_label}}<p style="margin-top:28px"><a class="btn" href="{{cta_href}}">{{cta_label}}</a></p>{{/cta_label}}</div></section>`,
  },
  {
    key: 'lfx_rich_text',
    name: 'Rich text',
    description: 'Free-form body copy',
    schema: {
      type: 'object',
      properties: {
        body: { type: 'string', format: 'html', title: 'Body' },
      },
      required: ['body'],
    },
    html: `<section class="band" data-block-root><div class="wrap prose">{{{body}}}</div></section>`,
  },
];

function blockMarker(b: BlockSpec, index: number): string {
  const attrs = `name=${b.name} | description=${b.description} | sort_order=${index + 1}`;
  const dataSource = b.fill
    ? `<!-- DATA_SOURCE:${JSON.stringify({ adapter: 'gatewaze', operation: 'lfx.fill', params: b.fill })} -->\n`
    : '';
  return `<!-- BLOCK:${b.key} | ${attrs} -->
<!-- SCHEMA:${JSON.stringify(b.schema)} -->
${dataSource}${b.html}
<!-- /BLOCK:${b.key} -->`;
}

/** The full `source.html` the templates parser ingests for this site. */
export function buildLfxSourceHtml(bundle: LfxBundle): string {
  const wrapper = `<!-- WRAPPER:${LFX_WRAPPER_KEY} | name=LFX foundation shell -->
<!-- SCHEMA:${JSON.stringify({ type: 'object', properties: { title: { type: 'string', title: 'Page title' } } })} -->
${buildWrapperHtml(bundle)}
<!-- /WRAPPER:${LFX_WRAPPER_KEY} -->`;
  const blocks = LFX_BLOCKS.map(blockMarker).join('\n\n');
  return `<!--
  Generated by the sites module's LFX importer from an lfx-mos-website bundle.
  Re-import the bundle to refresh brand CSS, chrome and copy.
-->

${wrapper}

${blocks}
`;
}
