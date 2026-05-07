/**
 * <GatewazeHead /> — operator-facing component that injects gatewaze's
 * analytics + A/B engine into the rendered site's <head>.
 *
 * Reads `/_gatewaze/site-config.json` (written by the publish-worker) to
 * learn which providers are configured, then mounts the matching <script>
 * tags client-side. Server-render returns null so initial HTML stays
 * provider-agnostic; tags appear on hydration.
 *
 * Trade-off: client-side mount means there's a brief window before tags
 * land where pageviews aren't tracked. For the v1 dogfood that's fine —
 * operators wanting first-paint coverage can bypass this and inline the
 * tags in their own layout (the JSON file format is documented + stable).
 */

import * as React from 'react';

export interface GatewazeHeadProps {
  /** Override the config path. Defaults to /_gatewaze/site-config.json. */
  configPath?: string;
}

interface SiteConfig {
  apiOrigin: string | null;
  analytics: {
    provider?: 'plausible' | 'fathom' | 'umami' | 'ga4' | 'none';
    umami?: { url?: string; websiteId?: string };
  };
  abBindingsUrl: string;
}

const BOOTSTRAP_FLAG = '__gatewazeHeadInstalled' as const;

declare global {
  interface Window {
    __gatewazeHeadInstalled?: boolean;
  }
}

export function GatewazeHead({ configPath = '/_gatewaze/site-config.json' }: GatewazeHeadProps) {
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window[BOOTSTRAP_FLAG]) return;
    window[BOOTSTRAP_FLAG] = true;

    let cancelled = false;

    fetch(configPath, { credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg: SiteConfig | null) => {
        if (cancelled || !cfg) return;
        installUmami(cfg);
        installAbBootstrap(cfg);
      })
      .catch(() => {
        // No config file (site not yet published, or theme integrated
        // before publish): silent no-op. Operator can verify the JSON
        // file exists at the expected path.
      });

    return () => {
      cancelled = true;
    };
  }, [configPath]);

  return null;
}

function installUmami(cfg: SiteConfig) {
  if (cfg.analytics.provider !== 'umami') return;
  const websiteId = cfg.analytics.umami?.websiteId;
  const url = cfg.analytics.umami?.url;
  if (!websiteId || !url) return;
  const s = document.createElement('script');
  s.defer = true;
  s.src = `${url.replace(/\/+$/, '')}/script.js`;
  s.dataset.websiteId = websiteId;
  document.head.appendChild(s);
}

function installAbBootstrap(cfg: SiteConfig) {
  if (!cfg.apiOrigin) return;
  // Inline the same bootstrap the emit-nextjs-routes blocks-mode layout
  // ships, kept in sync via shared shape (assign / impression / conversion
  // posts). When the theme's layout already includes the publish-worker-
  // emitted bootstrap (blocks-mode sites), the duplicate-install flag
  // above prevents double execution.
  const origin = cfg.apiOrigin.replace(/\/+$/, '');
  const inline = document.createElement('script');
  inline.textContent = `;(function(){
  if (typeof window === 'undefined') return;
  if (window.__gatewazeABBootstrapped) return;
  window.__gatewazeABBootstrapped = true;
  var origin = ${JSON.stringify(origin)};
  var sessionKey;
  try {
    sessionKey = localStorage.getItem('gatewaze_ab_session');
    if (!sessionKey) {
      sessionKey = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
      localStorage.setItem('gatewaze_ab_session', sessionKey);
    }
  } catch (e) {
    sessionKey = Date.now() + '-' + Math.random().toString(36).slice(2);
  }
  function pathKey() {
    var p = window.location.pathname.replace(/\\/+$/, '');
    return p === '' ? '/' : p;
  }
  function variantSlug() {
    var p = pathKey();
    if (p === '/') return 'index';
    return p.split('/').filter(Boolean).join('/');
  }
  fetch(${JSON.stringify(cfg.abBindingsUrl)}, { credentials: 'omit' })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .catch(function () { return {}; })
    .then(function (bindings) {
      var binding = bindings[pathKey()];
      if (!binding) return;
      function post(path, body) {
        return fetch(origin + '/api/ab/' + binding.testId + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'omit',
          keepalive: true,
        });
      }
      return post('/assign', { sessionKey: sessionKey })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (out) {
          if (!out || !out.variant) return;
          document.body.setAttribute('data-ab-variant', out.variant);
          document.body.setAttribute('data-ab-test-id', binding.testId);
          post('/impression', { sessionKey: sessionKey, variant: out.variant }).catch(function () {});
          return fetch('/content/pages/' + variantSlug() + '.' + out.variant + '.json', { credentials: 'omit' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function () { return null; })
            .then(function (variantBody) {
              window.gatewazeAB = {
                variant: out.variant,
                testId: binding.testId,
                goalEvent: binding.goalEvent,
                variantContent: variantBody && variantBody.content ? variantBody.content : null,
                recordConversion: function (goalEvent) {
                  return post('/conversion', {
                    sessionKey: sessionKey,
                    variant: out.variant,
                    goalEvent: goalEvent || binding.goalEvent,
                  }).catch(function () {});
                },
              };
              window.dispatchEvent(new CustomEvent('gatewaze:ab-ready', { detail: window.gatewazeAB }));
            });
        });
    });
})();`;
  document.head.appendChild(inline);
}
