/**
 * SiteShell — wraps a site-rendered page with compliance + auth chrome.
 *
 * Used by the portal's site-rendering route (which dispatches via the
 * host-router for `<slug>.sites.<brand>` requests). Per spec
 * §13 (compliance) + §12 (auth).
 *
 * Responsibilities:
 *   1. Inject the cookie consent loader when compliance module installed
 *      AND per-site override doesn't disable it
 *   2. Provide useCurrentUser context for auth-aware blocks (when
 *      site.auth_enabled = true)
 *   3. Emit page_view audit event when site.compliance_audit_enabled
 *
 * The portal route (e.g. app/(sites)/[siteSlug]/page.tsx) imports
 * SiteShell and wraps its rendered content.
 */

import type { ReactNode } from 'react';

export interface SiteShellSiteSummary {
  id: string;
  slug: string;
  name: string;
  auth_enabled: boolean;
  auth_session_cookie_domain: string | null;
  compliance_audit_enabled: boolean;
  compliance_overrides: Record<string, boolean>;
}

export interface SiteShellComplianceApi {
  /** True when compliance module enabled at platform level. */
  isInstalled(): boolean;
  /** Records a page_view event for this request. */
  emitPageView(args: { siteId: string; path: string; viewerId: string | null; anonId: string }): Promise<void>;
}

export interface SiteShellProps {
  site: SiteShellSiteSummary;
  /** Resolved compliance integration; null when module not installed. */
  compliance: SiteShellComplianceApi | null;
  /** Currently-authenticated user (or null for anon). Resolved upstream. */
  currentUser: { id: string; email: string } | null;
  /** Anon-viewer id from cookie (for audit + consent storage). */
  anonId: string;
  /** Path being rendered (e.g. /about). */
  path: string;
  /** The site-rendered page content. */
  children: ReactNode;
}

export function SiteShell(props: SiteShellProps) {
  const cookieBannerEnabled =
    props.compliance?.isInstalled() === true
    && props.site.compliance_overrides.cookie_banner_enabled !== false;

  // Audit page_view (fire-and-forget; doesn't block render)
  if (props.compliance && props.site.compliance_audit_enabled) {
    void props.compliance.emitPageView({
      siteId: props.site.id,
      path: props.path,
      viewerId: props.currentUser?.id ?? null,
      anonId: props.anonId,
    });
  }

  return (
    <>
      {props.children}
      {cookieBannerEnabled && <CookieConsentScript />}
    </>
  );
}

function CookieConsentScript() {
  // Reuses the existing portal CookieConsentLoader pattern.
  // The script reads data-brand from <html> and surfaces the banner.
  return (
    <script
      src="/js/cookieconsent/custom-consent.js?v=6"
      async
      defer
    />
  );
}
