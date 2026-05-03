/* @gatewaze:wrapper name="site" role="site" */

import type { ReactNode } from 'react';

interface SiteWrapperProps {
  children: ReactNode;
}

/**
 * Site-level wrapper: applied to every page on the site. Renders the
 * primary header (with the `primary` nav menu), the page content slot,
 * and the footer (with the `footer` nav menu).
 */
export function SiteWrapper({ children }: SiteWrapperProps) {
  return (
    <div className="min-h-screen flex flex-col bg-[var(--color-background)] text-[var(--color-foreground)]">
      <SiteHeader />
      <main className="flex-1 max-w-[var(--max-content-width)] mx-auto w-full px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

function SiteHeader() {
  // In the real runtime this calls useNavigationMenu('primary') to get items.
  return (
    <header className="border-b border-[var(--color-border)]">
      <div className="max-w-[var(--max-content-width)] mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <a href="/" className="font-semibold text-lg">Site name</a>
        <nav className="flex items-center gap-6 text-sm">
          <a href="/about">About</a>
          <a href="/docs">Docs</a>
          <a href="/blog">Blog</a>
          <a href="/contact">Contact</a>
        </nav>
      </div>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-[var(--color-border)] mt-16">
      <div className="max-w-[var(--max-content-width)] mx-auto px-4 sm:px-6 lg:px-8 py-8 text-sm text-[var(--color-muted)]">
        <p>© {new Date().getFullYear()} — Powered by gatewaze</p>
      </div>
    </footer>
  );
}
