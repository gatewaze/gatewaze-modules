'use client'

// Related-content panel for talk cards.
//
// When a visitor plays a talk's video, the card grows a "Related" panel
// resolved from the card's data-topics (curated pins first, then topic
// matches, then upcoming events — /api/related-content). Person-independent
// v1; the Signals module later re-ranks the same resolver per-person.
//
// A client component listening in the CAPTURE phase because the cards are
// dangerouslySetInnerHTML content whose play behavior is an inline onclick —
// React never owns those nodes, so the panel is built with vanilla DOM.
// Titles/descriptions are set via textContent (no injection surface).

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

interface RelatedCard {
  type: string
  title: string
  href: string
  description?: string
  image?: string
  meta?: string
  source: string
}

const PANEL_CLASS = 'gw-rel-panel'
const STYLE_ID = 'gw-rel-panel-style'

const PANEL_CSS = `
.${PANEL_CLASS} { overflow: hidden; max-height: 0; opacity: 0; transition: max-height .45s ease, opacity .35s ease .1s; }
.${PANEL_CLASS}.gw-rel-open { opacity: 1; }
.${PANEL_CLASS} .gw-rel-inner { border-top: 1px solid var(--line); padding-top: 14px; display: flex; flex-direction: column; gap: 10px; }
.${PANEL_CLASS} .gw-rel-label { font-size: 12px; font-weight: 700; color: var(--ink-3); letter-spacing: .04em; text-transform: uppercase; }
.${PANEL_CLASS} .gw-rel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.${PANEL_CLASS} a.gw-rel-card { display: flex; flex-direction: column; gap: 5px; border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: rgba(var(--ui-text), 0.03); text-decoration: none !important; color: inherit; transition: background .15s ease, border-color .15s ease; }
.${PANEL_CLASS} a.gw-rel-card:hover { background: rgba(var(--ui-text), 0.07); border-color: var(--accent); }
.${PANEL_CLASS} .gw-rel-type { font-size: 10.5px; font-weight: 700; color: var(--accent); letter-spacing: .05em; text-transform: uppercase; }
.${PANEL_CLASS} .gw-rel-title { font-size: 13.5px; font-weight: 600; color: var(--ink); line-height: 1.35; }
.${PANEL_CLASS} .gw-rel-desc { font-size: 12.5px; color: var(--ink-3); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.${PANEL_CLASS} .gw-rel-meta { font-size: 11.5px; color: var(--ink-3); margin-top: auto; padding-top: 2px; }
`

// Coarse visitor location for nearby-event ranking — shares the portal's
// existing IP-geo cache (useIpInfo hook: gatewaze_ip_info in localStorage,
// 30-min TTL, ipinfo.io) so whichever surface looks it up first pays once.
// A cache miss races a fresh lookup against a short timeout: the first play
// on a cold cache proceeds without geo rather than delaying the panel.
const IP_INFO_CACHE_KEY = 'gatewaze_ip_info'
const IP_INFO_CACHE_TTL = 1000 * 60 * 30

function cachedLoc(): { lat: number; lon: number } | null {
  try {
    const raw = localStorage.getItem(IP_INFO_CACHE_KEY)
    if (!raw) return null
    const { data, timestamp } = JSON.parse(raw)
    if (Date.now() - timestamp > IP_INFO_CACHE_TTL || typeof data?.loc !== 'string') return null
    const [lat, lon] = data.loc.split(',').map(parseFloat)
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null
  } catch {
    return null
  }
}

async function visitorLoc(): Promise<{ lat: number; lon: number } | null> {
  const cached = cachedLoc()
  if (cached) return cached
  const lookup = (async () => {
    const res = await fetch('https://ipinfo.io/json')
    if (!res.ok) return null
    const data = await res.json()
    try {
      localStorage.setItem(IP_INFO_CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }))
    } catch { /* storage full/blocked — lookup still usable this once */ }
    if (typeof data?.loc !== 'string') return null
    const [lat, lon] = data.loc.split(',').map(parseFloat)
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null
  })().catch(() => null)
  return Promise.race([lookup, new Promise<null>((r) => setTimeout(() => r(null), 400))])
}

function beacon(event: string, properties: Record<string, unknown>): void {
  try {
    navigator.sendBeacon('/api/t', new Blob([JSON.stringify({
      type: 'track',
      event,
      properties,
      client: { url: location.href, path: location.pathname + location.search, title: document.title },
    })], { type: 'application/json' }))
  } catch { /* tracking must never break the page */ }
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
}

function buildCard(card: RelatedCard): HTMLAnchorElement {
  const a = document.createElement('a')
  a.className = 'gw-rel-card'
  a.href = card.href
  const type = document.createElement('span')
  type.className = 'gw-rel-type'
  type.textContent = card.type
  const title = document.createElement('span')
  title.className = 'gw-rel-title'
  title.textContent = card.title
  a.append(type, title)
  if (card.description) {
    const desc = document.createElement('span')
    desc.className = 'gw-rel-desc'
    desc.textContent = card.description
    a.append(desc)
  }
  if (card.meta) {
    const meta = document.createElement('span')
    meta.className = 'gw-rel-meta'
    meta.textContent = card.meta
    a.append(meta)
  }
  a.addEventListener('click', () => beacon('related_click', { href: card.href, type: card.type, source: card.source }))
  return a
}

function expand(panel: HTMLElement): void {
  panel.classList.add('gw-rel-open')
  panel.style.maxHeight = `${panel.scrollHeight + 24}px`
}

/** Mirror of expand: animate closed, then remove once the transition ends. */
function collapse(panel: HTMLElement): void {
  if (panel.dataset.gwClosing) return
  panel.dataset.gwClosing = '1'
  panel.classList.remove('gw-rel-open')
  panel.style.maxHeight = '0px'
  let done = false
  const finish = () => {
    if (done) return
    done = true
    const card = panel.parentElement as HTMLElement | null
    if (card?.dataset) delete card.dataset.gwRel
    panel.remove()
  }
  panel.addEventListener('transitionend', finish, { once: true })
  window.setTimeout(finish, 600) // fallback: transition is .45s
}

async function openPanel(cardEl: HTMLElement, itemPath: string): Promise<void> {
  // one open panel at a time, matching single-video playback — the previous
  // card's panel animates closed rather than vanishing
  document.querySelectorAll<HTMLElement>(`.${PANEL_CLASS}`).forEach((p) => {
    if (p.parentElement !== cardEl) collapse(p)
  })
  // already open, mid-fetch, or known-empty (a zero-height child still adds
  // the card's flex gap, so the DOM is only touched once cards exist)
  if (cardEl.querySelector(`.${PANEL_CLASS}`) || cardEl.dataset.gwRel) return

  const topics = (cardEl.getAttribute('data-topics') || '').split(',').filter(Boolean)
  if (topics.length === 0) return

  cardEl.dataset.gwRel = 'loading'
  let cards: RelatedCard[] = []
  try {
    const loc = await visitorLoc()
    const geo = loc ? `&lat=${loc.lat}&lon=${loc.lon}` : ''
    const res = await fetch(`/api/related-content?topics=${encodeURIComponent(topics.join(','))}&exclude=${encodeURIComponent(itemPath)}${geo}`)
    cards = ((await res.json()) as { cards?: RelatedCard[] }).cards ?? []
  } catch { /* resolver failure = no panel, never a broken card */ }
  if (cards.length === 0) {
    cardEl.dataset.gwRel = 'empty' // don't refetch/flicker on replays
    return
  }
  delete cardEl.dataset.gwRel

  ensureStyle()
  const panel = document.createElement('div')
  panel.className = PANEL_CLASS
  cardEl.appendChild(panel)

  const inner = document.createElement('div')
  inner.className = 'gw-rel-inner'
  const label = document.createElement('span')
  label.className = 'gw-rel-label'
  label.textContent = 'Related'
  const grid = document.createElement('div')
  grid.className = 'gw-rel-grid'
  cards.forEach((c) => grid.appendChild(buildCard(c)))
  inner.append(label, grid)
  panel.appendChild(inner)

  requestAnimationFrame(() => expand(panel))
  beacon('related_panel_shown', {
    topics: topics.join(','),
    talk: cardEl.id,
    cards: cards.length,
    sources: cards.map((c) => c.source).join(','),
  })
}

export function RelatedSpy() {
  const pathname = usePathname()

  useEffect(() => {
    // the visitor might be on the anchor deep-link route — exclude the ITEM
    const parts = (pathname || '').split('/')
    const itemPath = parts[1] === 'resources' && parts.length >= 4 ? parts.slice(0, 4).join('/') : pathname || ''

    const onClick = (e: Event) => {
      const facade = (e.target as HTMLElement)?.closest?.('div[data-gw-video]')
      if (!facade) return
      const card = facade.closest('div[data-topics]') as HTMLElement | null
      if (card) void openPanel(card, itemPath)
    }
    // capture phase: coexists with the facade's inline onclick playback
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [pathname])

  return null
}

export default RelatedSpy
