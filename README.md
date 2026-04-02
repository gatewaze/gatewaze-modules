<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/gatewaze-logo-white.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/gatewaze-logo-black.svg">
    <img alt="Gatewaze" src="docs/assets/gatewaze-logo-black.svg" width="300">
  </picture>
</p>

<p align="center">
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License"></a>
</p>

**Open-source modules for [Gatewaze](https://github.com/gatewaze/gatewaze).**

This repository contains the official open-source module collection for the Gatewaze platform. Modules are self-contained packages that extend Gatewaze with additional capabilities — database migrations, admin UI pages, API routes, portal components, and background jobs.

---

## Available Modules

| Module | Description |
|--------|-------------|
| **events** | Core events management — create, manage, and run events with registrations, attendance tracking, and check-in |
| **compliance** | GDPR, CCPA, and SOC 2 compliance tools — consent records, privacy requests, data breach tracking, and audit logging |

## Installation

This repository is designed to sit alongside the main Gatewaze repository:

```
parent-directory/
  gatewaze/                # Core platform
  gatewaze-modules/        # This repo — open-source modules
```

The core platform's `pnpm-workspace.yaml` already references `../gatewaze-modules/modules/*`, so modules are automatically available after cloning.

```bash
git clone https://github.com/gatewaze/gatewaze-modules.git
cd gatewaze-modules
pnpm install
```

## Creating a Module

Use the `_template` directory as a starting point:

```bash
cp -r modules/_template modules/my-feature
```

Then update the module to fit your needs:

1. **`package.json`** — Set the module name, description, and any dependencies.
2. **`index.ts`** — Define the module's ID, features, routes, nav items, migrations, and lifecycle hooks.
3. **`migrations/`** — Add SQL migration files for your module's database schema.
4. **`admin/`** — Add React components for the admin interface.

### Module Structure

```
modules/my-feature/
  package.json          # Module package metadata
  tsconfig.json         # TypeScript configuration
  index.ts              # Module definition (routes, nav, migrations, config)
  admin/                # Admin UI components (React)
    pages/
      MyPage.tsx
  migrations/           # SQL migrations (applied in order)
    001_create_tables.sql
```

### Module Definition

Every module exports a `GatewazeModule` object from `index.ts`:

```typescript
import type { GatewazeModule } from '@gatewaze/shared';

const myModule: GatewazeModule = {
  id: 'my-feature',
  type: 'feature',
  visibility: 'public',
  name: 'My Feature',
  description: 'A short description of what this module does',
  version: '1.0.0',

  features: ['my-feature'],

  dependencies: [],

  migrations: [
    'migrations/001_create_tables.sql',
  ],

  adminRoutes: [
    {
      path: 'my-feature',
      component: () => import('./admin/pages/MyPage'),
      requiredFeature: 'my-feature',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/admin/my-feature',
      label: 'My Feature',
      icon: 'Puzzle',
      requiredFeature: 'my-feature',
      parentGroup: 'dashboards',
      order: 100,
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[my-feature] Module installed');
  },

  onEnable: async () => {
    console.log('[my-feature] Module enabled');
  },

  onDisable: async () => {
    console.log('[my-feature] Module disabled');
  },
};

export default myModule;
```

### What Modules Can Provide

- **Database migrations** — SQL files that create tables, indexes, RLS policies, and functions.
- **Admin routes** — React pages added to the admin dashboard.
- **Admin navigation** — Sidebar items linking to your admin pages.
- **Portal navigation** — Links added to the public-facing portal.
- **API routes** — Express routes registered with the API server.
- **Edge functions** — Supabase Edge Functions (Deno).
- **Configuration** — Schema-defined settings that admins can configure.
- **Lifecycle hooks** — Code that runs on install, enable, or disable.

For full documentation on the module system, see the [Module System Guide](https://github.com/gatewaze/gatewaze/blob/main/docs/modules.md) in the core repository.

## Development

```bash
# Type check all modules
pnpm typecheck

# Build all modules
pnpm build
```

## Project Structure

```
gatewaze-modules/
  modules/
    _template/        # Starting point for new modules
    compliance/       # GDPR/CCPA compliance tools
    events/           # Core events management
  package.json        # Root package configuration
  pnpm-workspace.yaml # Monorepo workspace definition
  tsconfig.base.json  # Shared TypeScript configuration
  docs/
    assets/           # Logo files
```

## Contributing

We welcome contributions! Please read the [Contributing Guide](./CONTRIBUTING.md) before getting started.

Key points:

- You must sign the [Contributor License Agreement](./CLA.md) before your first PR is merged.
- Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.
- All code must be written in TypeScript and pass linting and type checking.

## License

Gatewaze Modules is licensed under the [Apache License 2.0](./LICENSE).

```
Copyright 2026 Gatewaze Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

See [NOTICE](./NOTICE) for third-party attributions and [TRADEMARK.md](./TRADEMARK.md) for trademark usage policy.
