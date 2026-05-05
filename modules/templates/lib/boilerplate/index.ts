/**
 * Boilerplate-template helpers — implements the auto-clone path from
 * spec-content-modules-git-architecture §5.
 *
 * Two canonical boilerplate repos are referenced in the spec:
 *   - github.com/gatewaze/gatewaze-template-site       (Next.js + Tailwind)
 *   - github.com/gatewaze/gatewaze-template-newsletter (MJML)
 *
 * These exist as separate repos so non-Gatewaze users can fork/customise
 * them without touching the platform monorepo. Operators override via env
 * (e.g. an internal mirror or a brand-customised fork):
 *
 *   GATEWAZE_NEWSLETTER_BOILERPLATE_URL    default: github.com/gatewaze/gatewaze-template-newsletter
 *   GATEWAZE_NEWSLETTER_BOILERPLATE_BRANCH default: main
 *   GATEWAZE_NEWSLETTER_BOILERPLATE_PATH   default: <repo root>
 *
 *   GATEWAZE_SITE_BOILERPLATE_URL          default: github.com/gatewaze/gatewaze-template-site
 *   GATEWAZE_SITE_BOILERPLATE_BRANCH       default: main
 *   GATEWAZE_SITE_BOILERPLATE_PATH         default: <repo root>
 *
 * The canonical repos are not published yet (see spec §4.4). Until they
 * land, this helper returns the URL anyway — the actual clone fails with a
 * clear error and the admin UI surfaces it. Operators with their own theme
 * repo can override the env to point at it.
 */

export type HostKind = 'newsletter' | 'site';

export interface BoilerplateConfig {
  /** The canonical boilerplate URL for this host_kind. Always non-empty. */
  url: string;
  /** Branch to clone from. */
  branch: string;
  /** Optional sub-path within the repo to walk for templates. */
  manifestPath?: string;
  /** Human label shown to admins in the source list. */
  label: string;
}

const DEFAULTS: Record<HostKind, BoilerplateConfig> = {
  newsletter: {
    url: 'https://github.com/gatewaze/gatewaze-template-newsletter.git',
    branch: 'main',
    label: 'Gatewaze newsletter boilerplate',
  },
  site: {
    url: 'https://github.com/gatewaze/gatewaze-template-site.git',
    branch: 'main',
    label: 'Gatewaze site boilerplate',
  },
};

const ENV_PREFIX: Record<HostKind, string> = {
  newsletter: 'GATEWAZE_NEWSLETTER_BOILERPLATE',
  site: 'GATEWAZE_SITE_BOILERPLATE',
};

/**
 * Resolve the boilerplate config for a given host_kind. Env vars override
 * defaults; the result is always non-empty.
 */
export function getBoilerplateConfig(
  hostKind: HostKind,
  env: NodeJS.ProcessEnv = process.env,
): BoilerplateConfig {
  const prefix = ENV_PREFIX[hostKind];
  const fallback = DEFAULTS[hostKind];
  const url = env[`${prefix}_URL`]?.trim() || fallback.url;
  const branch = env[`${prefix}_BRANCH`]?.trim() || fallback.branch;
  const manifestPathRaw = env[`${prefix}_PATH`]?.trim() || fallback.manifestPath;
  return {
    url,
    branch,
    manifestPath: manifestPathRaw && manifestPathRaw.length > 0 ? manifestPathRaw : undefined,
    label: fallback.label,
  };
}

/**
 * True iff the operator hasn't overridden the URL — useful for the admin
 * UI to surface "you're using the canonical (not-yet-published) boilerplate;
 * point GATEWAZE_*_BOILERPLATE_URL at your own fork to silence this".
 */
export function isUsingDefaultBoilerplate(
  hostKind: HostKind,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const prefix = ENV_PREFIX[hostKind];
  return !env[`${prefix}_URL`] || env[`${prefix}_URL`]?.trim() === '';
}
