# Site Runtime

Tiny React helper that operator themes import to surface gatewaze-emitted analytics + A/B engine into rendered sites. Designed for schema-mode sites where the operator owns their `app/layout.tsx` and the publish-worker doesn't replace it.

## When you need this

- Your site is `composition_mode='schema'` and your theme owns its Next.js layout.
- You want Umami tracking + A/B engine to appear in the rendered HTML without hand-rolling `<script>` tags.

For blocks-mode sites with a gatewaze-supplied wrapper the publish-worker injects the same content into `app/layout.tsx` server-side — no integration step needed there.

## Install

The package ships under `MODULE_SOURCES` like every other gatewaze module. Your theme's `package.json` declares it as a peer:

```json
{
  "peerDependencies": {
    "@gatewaze-modules/site-runtime": "*",
    "react": "^18.0.0 || ^19.0.0"
  }
}
```

## Use

In your theme's `app/layout.tsx`:

```tsx
import { GatewazeHead } from '@gatewaze-modules/site-runtime';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <GatewazeHead />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

That's it. On hydration, `<GatewazeHead />` fetches `/_gatewaze/site-config.json` (which the publish-worker emits into `public/`) and:

- Injects the Umami `<script defer src=… data-website-id=…>` if `analytics.provider === 'umami'`.
- Installs the A/B bootstrap that mints a session key, fetches the per-route binding, calls `assign` / `impression`, sets `<body data-ab-variant="…">`, fetches the variant content, and exposes `window.gatewazeAB`.

## Trade-off

The component is client-side only — the initial HTML is provider-agnostic and tags appear on hydration. Pageviews aren't tracked in the brief window before mount.

For first-paint coverage, bypass the component and inline the tags directly in your layout. The `site-config.json` shape is documented + stable:

```json
{
  "apiOrigin": "https://api.example.com",
  "analytics": {
    "provider": "umami",
    "umami": { "url": "https://umami.example.com", "websiteId": "abc-123" }
  },
  "abBindingsUrl": "/_gatewaze/ab-bindings.json"
}
```

You can read that file at build time (Next.js fetches `public/` files relative to the project root) and emit the `<script>` tags inline.

## Reading variant content from your theme

Once `<GatewazeHead />` has hydrated and an A/B test is bound to the current route, the bootstrap exposes:

```ts
window.gatewazeAB = {
  variant: 'b',
  testId: 'uuid…',
  goalEvent: 'signup_clicked',
  variantContent: { /* pages_content_variants.content for this variant */ },
  recordConversion: (goalEvent?: string) => Promise<void>,
};
```

Two ways to consume:

### CSS-only branching

The bootstrap sets `<body data-ab-variant="b" data-ab-test-id="…">`. If your variant differs only in copy / colors / spacing, key your CSS off the attribute:

```css
body[data-ab-variant="b"] .hero-headline { color: var(--accent-vivid); }
body[data-ab-variant="b"] .hero-cta { background: oklch(0.7 0.2 30); }
```

### React state — listen for the ready event

```tsx
'use client';

import { useEffect, useState } from 'react';

export function HeroSection({ defaultProps }: { defaultProps: HeroProps }) {
  const [props, setProps] = useState(defaultProps);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.variantContent?.hero) {
        setProps({ ...defaultProps, ...detail.variantContent.hero });
      }
    };
    window.addEventListener('gatewaze:ab-ready', handler);
    // Also handle the case where the event fired before mount.
    if (typeof window !== 'undefined' && window.gatewazeAB?.variantContent?.hero) {
      setProps({ ...defaultProps, ...window.gatewazeAB.variantContent.hero });
    }
    return () => window.removeEventListener('gatewaze:ab-ready', handler);
  }, [defaultProps]);

  return <Hero {...props} />;
}
```

## Recording conversions

Wire your CTA's submit / click handler to call `recordConversion()`:

```tsx
async function onSignup() {
  await postSignup(formData);
  if (typeof window !== 'undefined' && window.gatewazeAB) {
    await window.gatewazeAB.recordConversion();
  }
  router.push('/welcome');
}
```

The default `goalEvent` matches the test's configured goal event. Pass an override if you want to track a different event:

```ts
window.gatewazeAB.recordConversion('newsletter_subscribed');
```

(Goal events that don't match the test's configured `goalEvent` are rejected with HTTP 400 by the public API.)

## What you DON'T need to wire

- No tracking script `<script>` boilerplate — `<GatewazeHead />` injects it.
- No localStorage session key handling — the bootstrap mints + persists it.
- No fetch wrappers for `/api/ab/...` — the bootstrap calls them.
- No CORS config for the public API — the endpoints are anonymous and `credentials: 'omit'`.

## TypeScript

```ts
declare global {
  interface Window {
    gatewazeAB?: {
      variant: string;
      testId: string;
      goalEvent: string;
      variantContent: Record<string, unknown> | null;
      recordConversion(goalEvent?: string): Promise<void>;
    };
  }
}
```

Add this to your theme's global types if you want strict typing on `window.gatewazeAB` reads.
