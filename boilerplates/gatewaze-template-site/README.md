# gatewaze-template-site

Default site boilerplate for the gatewaze sites module (canonical home: `github.com/gatewaze/gatewaze-template-site`).

When a new site is created in gatewaze without an external git URL, this template is cloned at the pinned version into the site's internal git repo. The `name` field of `package.json` is rewritten to `gatewaze-site-<slug>` and the initial commit is pushed.

## Marker grammar

Components are surfaced to the gatewaze admin's block-and-page editor via marker comments:

```tsx
/* @gatewaze:block name="hero" category="hero" description="Top-of-page hero with CTA" */
export function Hero(props: HeroProps) { ... }
```

Recognized attributes:

| Attribute | Required | Notes |
|---|---|---|
| `name` | yes | kebab-case identifier; unique within the theme |
| `kind` | no | `static` (default) / `ai-generated` / `gatewaze-internal` / `user-personalized` / `external-fetched` / `embed` / `computed` |
| `audience` | no | `public` (default) / `authenticated` / `authenticated_optional` |
| `freshness` | conditional | `live` / `build-time` — required for `gatewaze-internal` and `external-fetched` |
| `category` | no | palette grouping in the editor |
| `description` | no | admin tooltip |
| `deprecated` | no | `true` flags the block but keeps it usable |
| `requires_consent` | no | comma-separated compliance categories (e.g. `analytics,marketing`) |

Kind-specific attributes:

- `ai-generated`: `cadence` (`before-publish` | `scheduled` | `manual`), `model` (e.g. `claude-sonnet`)
- `gatewaze-internal`: `source` (registered source provider slug, e.g. `events`, `blogs`)
- `external-fetched`: `cache_ttl_seconds`, `auth_secret_key`
- `embed`: `provider` (e.g. `youtube`, `calendly`)
- `computed`: `inputs` (comma-separated kinds it reads from)

## Wrappers

```tsx
/* @gatewaze:wrapper name="site" role="site" */
export function SiteWrapper({ children }: { children: ReactNode }) { ... }

/* @gatewaze:wrapper name="docs" role="page" */
export function DocsWrapper({ children }: { children: ReactNode }) { ... }
```

Per spec §10: each site has exactly one `role=site` wrapper (always applied) and any number of `role=page` wrappers (assigned per-page or by path-prefix manifest in `gatewaze.theme.json`).

## SSR helpers

Wrappers and blocks have access to per-request hooks at SSR time:

```tsx
import { useCurrentUser, useUserRelation, useNavigationMenu, useSectionPages, useSiteMeta } from '@gatewaze/sites/runtime';

const user = useCurrentUser();
const sectionPages = useSectionPages('/docs/');
const menu = useNavigationMenu('primary');
```

## Local development

```sh
pnpm install
pnpm dev
```

By default the template renders against mock content. To preview against real gatewaze content, set `GATEWAZE_API_URL` and `GATEWAZE_SITE_SLUG`.

## License

Apache-2.0
