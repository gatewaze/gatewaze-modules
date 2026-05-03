/**
 * Compliance integration — auto-applied when the compliance module is
 * installed.
 *
 * Per spec-content-modules-git-architecture §13:
 *
 *   1. Cookie consent banner injected on every site page (positionable,
 *      themed via gatewaze.theme.json tokens).
 *   2. Auto-generated routes:
 *        /privacy, /terms, /cookie-policy
 *        /account/privacy-requests, /account/data-export
 *      Theme can override by providing a same-path page in `main`.
 *   3. Audit logging hook (off per-site by default; enabled via
 *      sites.compliance_audit_enabled).
 *   4. Block-level `requires_consent` gate: blocks render only if user has
 *      consented to all listed categories.
 *
 * The integration is "active" only when the compliance module is detected
 * in the platform's module registry.
 */

export interface ComplianceModuleApi {
  /** True when the compliance module is installed + enabled at platform level. */
  isInstalled(): boolean;
  /** Categories defined by the compliance module (analytics/functional/marketing). */
  getCategories(): string[];
  /** Check if a viewer has consented to a category. */
  hasConsent(category: string, viewerId: string | null, anonId: string): boolean | Promise<boolean>;
  /** Emit an audit-log event. */
  emitAuditEvent(event: AuditEvent): Promise<void>;
  /** Get the current compliance module's privacy / terms / cookie-policy markdown. */
  getStaticContent(slug: 'privacy' | 'terms' | 'cookie-policy'): Promise<string | null>;
}

export interface AuditEvent {
  siteId: string;
  kind: 'page_view' | 'form_submit' | 'conversion' | 'login' | 'logout';
  viewerId: string | null;
  /** Anonymous identifier for unauthenticated viewers (cookie-derived). */
  anonId: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface SiteComplianceConfig {
  /** Per-site override: { cookie_banner_enabled, privacy_routes_enabled, audit_enabled } */
  overrides: Record<string, boolean>;
  /** Hard column on sites table. */
  auditEnabled: boolean;
}

export interface ComplianceIntegration {
  /**
   * Should the cookie banner render on this site? Returns true if module
   * installed AND per-site override doesn't disable it.
   */
  shouldRenderCookieBanner(siteConfig: SiteComplianceConfig): boolean;

  /**
   * Should auto-generated /privacy, /terms, /cookie-policy routes be
   * served by gatewaze (vs. left to the theme)? True if module installed
   * AND per-site override doesn't disable them AND the theme doesn't
   * define a same-path page in `main`.
   */
  shouldServeAutoRoute(slug: 'privacy' | 'terms' | 'cookie-policy', siteConfig: SiteComplianceConfig): boolean;

  /**
   * Should an audit event be emitted? True if module installed AND
   * per-site `audit_enabled` is set.
   */
  shouldEmitAudit(siteConfig: SiteComplianceConfig): boolean;

  /**
   * Resolve consent for a viewer. Returns `true` if module not installed
   * (no consent required), or if module installed AND viewer has consented
   * to all categories.
   */
  hasConsentForBlock(requiresConsent: string[] | null, viewerId: string | null, anonId: string): Promise<boolean>;

  /**
   * Get the rendered static content for a managed route (privacy/terms/etc.).
   */
  getAutoRouteContent(slug: 'privacy' | 'terms' | 'cookie-policy'): Promise<string | null>;
}

export class ComplianceIntegrationImpl implements ComplianceIntegration {
  constructor(private complianceApi: ComplianceModuleApi | null) {}

  shouldRenderCookieBanner(siteConfig: SiteComplianceConfig): boolean {
    if (!this.complianceApi?.isInstalled()) return false;
    return siteConfig.overrides.cookie_banner_enabled !== false; // default true
  }

  shouldServeAutoRoute(slug: 'privacy' | 'terms' | 'cookie-policy', siteConfig: SiteComplianceConfig): boolean {
    if (!this.complianceApi?.isInstalled()) return false;
    return siteConfig.overrides.privacy_routes_enabled !== false; // default true
    // Note: theme override (same-path page in `main`) is checked at the route
    // matcher level, not here.
  }

  shouldEmitAudit(siteConfig: SiteComplianceConfig): boolean {
    if (!this.complianceApi?.isInstalled()) return false;
    return siteConfig.auditEnabled === true; // default false
  }

  async hasConsentForBlock(
    requiresConsent: string[] | null,
    viewerId: string | null,
    anonId: string,
  ): Promise<boolean> {
    if (!requiresConsent || requiresConsent.length === 0) return true;
    if (!this.complianceApi?.isInstalled()) {
      // Module not installed — block requires consent that can't be checked.
      // Conservative: render placeholder. (Spec §13.2 says "consent required to view".)
      return false;
    }
    for (const category of requiresConsent) {
      const ok = await this.complianceApi.hasConsent(category, viewerId, anonId);
      if (!ok) return false;
    }
    return true;
  }

  async getAutoRouteContent(slug: 'privacy' | 'terms' | 'cookie-policy'): Promise<string | null> {
    if (!this.complianceApi?.isInstalled()) return null;
    return this.complianceApi.getStaticContent(slug);
  }
}

/**
 * Module-discovery helper. Called by the SSR runtime at request boundary
 * to resolve the compliance integration.
 *
 * In v1 the discovery is via the platform's module registry (set at app
 * startup). When the compliance module is loaded, it calls
 * `registerComplianceApi(api)` so the integration can find it.
 */
let registeredApi: ComplianceModuleApi | null = null;

export function registerComplianceApi(api: ComplianceModuleApi): void {
  registeredApi = api;
}

export function getComplianceIntegration(): ComplianceIntegration {
  return new ComplianceIntegrationImpl(registeredApi);
}
