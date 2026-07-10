// Server-side block rendering for resource item pages.
//
// Blocks render to HTML strings, not JSX: the talk-card markup (ported
// byte-for-byte from the md2cards.py generator that used to bake it into
// sr_sections.content) carries inline onclick handlers for the YouTube
// facade (single-playback + play-tracking beacon) and the copy-link chip,
// which React cannot emit as attributes. Building the same escaped string
// the generator built is also what makes the SSR parity harness meaningful.
// All data fields are escaped before interpolation; only `html`-kind
// payloads pass through verbatim (same trust model as legacy content).
//
// Precedence rule (normative, from the structured-blocks spec): a section
// with >=1 block renders its blocks and ignores `content`; otherwise legacy
// `content` renders exactly as before. RESOURCES_FORCE_LEGACY_SECTIONS=true
// is the incident kill switch back to legacy-only rendering.

export interface SrBlockRow {
  id: string
  kind: string
  slug: string | null
  sort_order: number
  data: Record<string, any>
}

export interface SectionWithBlocks {
  id: string
  heading: string
  content: string | null
  sort_order: number
  blocks?: SrBlockRow[]
}

export interface RenderCtx {
  /** e.g. /resources/conference-recap/mcp-dev-summit-bengaluru */
  pagePath: string
}

const NOLINE = 'text-decoration:none !important;'
const MUTED = 'font-size:14px; line-height:1.5; color:var(--ink-3); margin:2px 0 0;'

const PLAY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg>'
const LINK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'
const CHECK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'
const LINKEDIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"' +
  ' fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328' +
  '-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046' +
  'c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144' +
  ' 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0' +
  ' 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792' +
  ' 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24' +
  ' 22.271V1.729C24 .774 23.2 0 22.225 0z"/></svg>'

/** Same escaping as the generator: text nodes escape & < > only. */
function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** json.dumps parity: ": "/", " separators + \uXXXX for non-ASCII. */
function pyJson(obj: Record<string, string>): string {
  const enc = (s: string) =>
    JSON.stringify(s).replace(/[-￿]/g, (c) =>
      '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  return '{' + Object.entries(obj).map(([k, v]) => `${enc(k)}: ${enc(v)}`).join(', ') + '}'
}

function label(color: string): string {
  return `font-size:12px; font-weight:700; color:${color}; letter-spacing:.03em; margin:0;`
}

function videoEmbed(youtubeId: string, color: string, title: string): string {
  const embed = `https://www.youtube-nocookie.com/embed/${youtubeId}`
  const thumb = `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`
  const props = pyJson({ video_id: youtubeId, talk: title })
  const js =
    'var self=this;' +
    'if(!self.dataset.f){self.dataset.f=self.innerHTML;}' +
    "document.querySelectorAll('div[data-gw-video]').forEach(function(d){" +
    "if(d!==self&&d.dataset.f&&d.querySelector('iframe')){d.innerHTML=d.dataset.f;}});" +
    `var p=${props};` +
    "try{navigator.sendBeacon('/api/t',new Blob([JSON.stringify({type:'track',event:'video_play'," +
    'properties:p,client:{url:location.href,path:location.pathname+location.search,title:document.title}})],' +
    "{type:'application/json'}))}catch(e){}" +
    ";var f=document.createElement('iframe');" +
    `f.src='${embed}?autoplay=1';` +
    "f.allow='autoplay; fullscreen; encrypted-media; picture-in-picture; accelerometer; gyroscope; clipboard-write';" +
    'f.allowFullscreen=true;' +
    "f.style.cssText='position:absolute;inset:0;width:100%;height:100%;border:0';" +
    'self.replaceChildren(f)'
  const onclick = js.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return (
    '<div role="button" tabindex="0" data-gw-video aria-label="Play recording" style="position:relative;' +
    ' aspect-ratio:16/9; border-radius:10px; overflow:hidden; background:#000; align-self:start;' +
    ` min-width:0; cursor:pointer;" onclick="${onclick}"` +
    ' onkeydown="if(event.key===\'Enter\')this.click()">' +
    `<img src="${thumb}" alt="" loading="lazy" style="position:absolute; inset:0; width:100%;` +
    ' height:100%; object-fit:cover; opacity:.85;">' +
    `<span style="position:absolute; inset:0; margin:auto; width:68px; height:48px;` +
    ` border-radius:12px; background:${color}; display:flex; align-items:center;` +
    ` justify-content:center; color:#111;">${PLAY_SVG}</span></div>`
  )
}

function copyLinkChip(tid: string, pagePath: string): string {
  const js =
    'event.preventDefault();' +
    "try{navigator.clipboard.writeText(location.origin+this.getAttribute('href'))}catch(e){}" +
    `var el=document.getElementById('${tid}');if(el)el.scrollIntoView({behavior:'smooth',block:'start'});` +
    "var a=this;var l=a.querySelector('.gw-ic-l');var c=a.querySelector('.gw-ic-c');" +
    "l.style.display='none';c.style.display='inline-flex';" +
    "clearTimeout(a._t);a._t=setTimeout(function(){c.style.display='none';l.style.display='inline-flex';},1400);"
  return (
    `<a href="${pagePath}/${tid}" title="Copy link to this talk" aria-label="Copy link to this talk"` +
    ` onclick="${js}"` +
    ' style="margin-left:auto; flex:none; display:inline-flex; align-items:center; justify-content:center;' +
    ' width:26px; height:26px; border-radius:7px; border:1px solid var(--line);' +
    ' background:rgba(var(--ui-text), 0.06); color:var(--ink-3); text-decoration:none !important;">' +
    `<span class="gw-ic-l" style="display:inline-flex;">${LINK_SVG}</span>` +
    `<span class="gw-ic-c" style="display:none; color:var(--accent);">${CHECK_SVG}</span></a>`
  )
}

function nameLink(name: string, url: string | undefined): string {
  if (!url) return esc(name)
  let icon = ''
  if (url.includes('linkedin.com')) {
    icon =
      '<span style="display:inline-flex; align-items:center; justify-content:center;' +
      ' width:22px; height:22px; border-radius:6px; border:1px solid var(--line);' +
      ' background:rgba(var(--ui-text), 0.06); vertical-align:middle; margin-left:10px;' +
      ` opacity:.85;">${LINKEDIN_SVG}</span>`
  }
  return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:inherit; ${NOLINE}">${esc(name)}${icon}</a>`
}

interface TalkData {
  title: string
  number?: number
  speaker: { name: string; company?: string; linkedin?: string }
  speakers?: Array<{ name: string; url?: string }>
  youtube_id?: string
  url?: string
  worth_noting?: string
  quote?: string
  accent?: string
}

/** One talk card — a byte-faithful port of md2cards.py card(). */
export function renderTalkCardHtml(block: SrBlockRow, index: number, ctx: RenderCtx): string {
  const data = block.data as TalkData
  const tid = block.slug ?? `talk-${block.id}`
  const color = data.accent ?? '#a78bfa'
  const num = data.number ?? index + 1
  const title = data.title ?? ''
  const url = data.url ?? (data.youtube_id ? `https://youtu.be/${data.youtube_id}` : '#')

  const speakerList: Array<{ name: string; url?: string; join?: string }> =
    data.speakers && data.speakers.length > 0
      ? data.speakers
      : [{ name: data.speaker?.name ?? '', url: data.speaker?.linkedin }]
  const namesHtml = speakerList
    .map((s, i) => (i === 0 ? '' : s.join === '&' ? ' &amp; ' : ', ') + nameLink(s.name, s.url))
    .join('')
  const sub = data.speaker?.company ?? ''
  const subHtml = esc(sub).replace(/ · /g, ' &middot; ')
  const subBlock = sub
    ? `\n      <div style="font-size:12.5px; color:var(--ink-3); line-height:1.4; margin-top:2px;">${subHtml}</div>`
    : ''

  const video = data.youtube_id ? videoEmbed(data.youtube_id, color, title) : ''

  return `
  <div id="${tid}" style="border:1px solid var(--line); border-top:3px solid ${color}; background:var(--paper); border-radius:14px; padding:18px; display:flex; flex-direction:column; gap:14px; scroll-margin-top:96px;">
    <div style="display:flex; align-items:flex-start; gap:12px;">
      <span style="flex:none; min-width:32px; height:32px; display:inline-flex; align-items:center; justify-content:center; background:${color}26; color:${color}; border-radius:9px; font-weight:700; font-size:16px;">${num}</span>
      <div style="min-width:0;">
      <div style="font-size:15.5px; font-weight:700; color:var(--ink); line-height:1.35;">${namesHtml}</div>${subBlock}
      </div>
      ${copyLinkChip(tid, ctx.pagePath)}
    </div>
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:18px 32px;">
      <div style="display:flex; flex-direction:column; gap:12px; min-width:0;">
        <h3 style="margin:0; font-size:17px; line-height:1.35;"><a href="${url}" target="_blank" rel="noopener noreferrer" style="color:inherit; ${NOLINE}">${esc(title)}</a></h3>
        <div>
          <p style="${label('var(--ink)')}">Worth noting</p>
          <p style="${MUTED}">${esc(data.worth_noting ?? '')}</p>
        </div>
        <div>
          <p style="${label('var(--ink)')}">Quote</p>
          <p style="${MUTED} font-style:italic;">${esc(data.quote ?? '')}</p>
        </div>
      </div>
      ${video}
    </div>
  </div>`
}

function logBlockEvent(event: string, block: SrBlockRow, extra?: Record<string, unknown>): void {
  // structured warn logs: ids and kind only, never payloads
  console.warn(JSON.stringify({ event, block_id: block.id, block_slug: block.slug, kind: block.kind, ...extra }))
}

/** Render one block to HTML. Unknown kinds fall back to data.html (deploy-skew safety net). */
function renderBlockHtml(block: SrBlockRow, index: number, ctx: RenderCtx): string {
  try {
    if (block.kind === 'html') {
      return typeof block.data?.html === 'string' ? block.data.html : ''
    }
    if (block.kind === 'talk') {
      return renderTalkCardHtml(block, index, ctx)
    }
    if (typeof block.data?.html === 'string') {
      logBlockEvent('resources.block.unknown_kind', block)
      return block.data.html
    }
    logBlockEvent('resources.block.unknown_kind', block)
    return ''
  } catch (err) {
    logBlockEvent('resources.block.render_error', block, { message: err instanceof Error ? err.message : String(err) })
    return ''
  }
}

const CARD_GRID_OPEN = '<div style="display:grid; grid-template-columns:1fr; gap:16px; margin:6px 0 10px;">'

export function forceLegacySections(): boolean {
  return process.env.RESOURCES_FORCE_LEGACY_SECTIONS === 'true'
}

/**
 * The body HTML for a section under the precedence rule. Consecutive talk
 * blocks group into the same card grid the generator used to emit, so a
 * talk-section's markup is unchanged; html blocks pass through verbatim.
 * Returns null when there is nothing to render.
 */
export function sectionBodyHtml(section: SectionWithBlocks, ctx: RenderCtx): string | null {
  const blocks = (section.blocks ?? [])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1))

  if (forceLegacySections() || blocks.length === 0) {
    if (blocks.length > 0 && !section.content) {
      // post-promotion section under the kill switch: renders empty, loudly
      console.warn(JSON.stringify({ event: 'resources.legacy_flag.null_content', section_id: section.id }))
    }
    return section.content || null
  }

  const parts: string[] = []
  let talkRun: string[] = []
  const flushTalks = () => {
    if (talkRun.length > 0) {
      parts.push(CARD_GRID_OPEN + talkRun.join('') + '\n</div>')
      talkRun = []
    }
  }
  blocks.forEach((block) => {
    if (block.kind === 'talk') {
      talkRun.push(renderBlockHtml(block, talkRun.length, ctx))
    } else {
      flushTalks()
      parts.push(renderBlockHtml(block, 0, ctx))
    }
  })
  flushTalks()
  const html = parts.join('')
  if (html === '' && blocks.length > 0) {
    console.warn(JSON.stringify({ event: 'resources.section.all_blocks_failed', section_id: section.id, blocks: blocks.length }))
  }
  return html || null
}
