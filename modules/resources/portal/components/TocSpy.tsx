'use client'

// Scrollspy + anchor auto-focus for resource item pages.
//
// A client component (not an inline <script>) because inline scripts only
// execute on full page loads — on App Router soft navigations they are
// inserted but never run, which left the TOC highlight dead after internal
// navigation. Effects keyed on the pathname re-arm on every navigation.
//
// Scroller-agnostic by design: section positions are measured against the
// viewport and scroll events are captured at the document level, so it works
// in both the public shell (.pub-area scroller) and the signed-in workspace
// shell (.gw-content scroller).

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

const TOC_LINKS = '.res-toc a[href^="#"], .res-toc-inline a[href^="#"]'
const READING_LINE_PX = 140

function tocLinks(): HTMLAnchorElement[] {
  return Array.from(document.querySelectorAll<HTMLAnchorElement>(TOC_LINKS))
}

function linkTarget(link: HTMLAnchorElement): string {
  return decodeURIComponent((link.getAttribute('href') || '').slice(1))
}

export function TocSpy({ focusId }: { focusId?: string }) {
  const pathname = usePathname()

  // Highlight the TOC entry whose section is at the reading line. Links and
  // sections are re-queried live on every update: content streams in via
  // Suspense, so anything cached at mount goes stale.
  useEffect(() => {
    let ticking = false
    const update = () => {
      ticking = false
      const links = tocLinks()
      if (!links.length) return
      const sections = links
        .map((l) => document.getElementById(linkTarget(l)))
        .filter((el): el is HTMLElement => !!el && el.getClientRects().length > 0)
      if (!sections.length) return
      let current = sections[0].id
      for (const s of sections) {
        if (s.getBoundingClientRect().top <= READING_LINE_PX) current = s.id
      }
      for (const l of links) {
        if (linkTarget(l) === current) l.setAttribute('aria-current', 'page')
        else l.removeAttribute('aria-current')
      }
    }
    const onScroll = () => {
      if (!ticking) {
        ticking = true
        requestAnimationFrame(update)
      }
    }
    document.addEventListener('scroll', onScroll, { passive: true, capture: true })
    // settle passes for streamed-in sections
    const timers = [0, 400, 1200, 2500].map((ms) => window.setTimeout(update, ms))
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      timers.forEach((t) => window.clearTimeout(t))
    }
  }, [pathname])

  // Anchor deep links: scroll the target block into view once it has layout
  // (streamed sections live in hidden templates first), flash a highlight
  // ring, and re-assert after hydration/shell remounts unless the user has
  // taken over.
  useEffect(() => {
    if (!focusId) return
    let cancelled = false
    const cancel = () => {
      cancelled = true
    }
    const cancelEvents: Array<keyof WindowEventMap> = ['wheel', 'touchstart', 'keydown']
    cancelEvents.forEach((ev) => window.addEventListener(ev, cancel, { passive: true, once: true }))

    const go = (): boolean => {
      const el = document.getElementById(focusId)
      if (!el || !el.getClientRects().length) return false
      el.scrollIntoView({ block: 'start' })
      el.style.boxShadow = '0 0 0 2px var(--accent)'
      window.setTimeout(() => {
        el.style.boxShadow = ''
      }, 4000)
      return true
    }

    const timers: number[] = []
    const settle = () => {
      for (const ms of [600, 1600, 3200]) {
        timers.push(
          window.setTimeout(() => {
            if (!cancelled) go()
          }, ms),
        )
      }
    }
    let tries = 0
    const poll = window.setInterval(() => {
      if (go()) {
        window.clearInterval(poll)
        settle()
      } else if (++tries > 80) {
        window.clearInterval(poll)
      }
    }, 200)
    if (go()) {
      window.clearInterval(poll)
      settle()
    }
    return () => {
      window.clearInterval(poll)
      timers.forEach((t) => window.clearTimeout(t))
      cancelEvents.forEach((ev) => window.removeEventListener(ev, cancel))
    }
  }, [focusId, pathname])

  return null
}

export default TocSpy
