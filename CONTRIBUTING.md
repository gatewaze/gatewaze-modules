# Contributing to Gatewaze Modules

Thank you for your interest in contributing to Gatewaze Modules! This guide covers everything you need to get started.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Contributor License Agreement](#contributor-license-agreement)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Code Standards](#code-standards)
- [Commit Message Format](#commit-message-format)
- [Pull Request Process](#pull-request-process)
- [Creating a Module](#creating-a-module)
- [Reporting Issues](#reporting-issues)

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for everyone. Be kind, constructive, and professional in all interactions.

## Contributor License Agreement

**You must sign the [Contributor License Agreement (CLA)](./CLA.md) before your first pull request can be merged.** The CLA ensures that contributions can be legally distributed under the project's Apache 2.0 license while you retain copyright over your work.

When you open your first PR, the CLA bot will guide you through the signing process.

## Getting Started

1. **Fork the repository** on GitHub.
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/<your-username>/gatewaze-modules.git
   cd gatewaze-modules
   ```
3. **Add the upstream remote**:
   ```bash
   git remote add upstream https://github.com/gatewaze/gatewaze-modules.git
   ```
4. **Create a branch** for your changes:
   ```bash
   git checkout -b feat/your-feature-name
   ```

## Development Setup

### Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9
- **Git**

You will also need the core [Gatewaze](https://github.com/gatewaze/gatewaze) repository cloned as a sibling directory for type definitions and the shared package:

```
parent-directory/
  gatewaze/                # Core platform
  gatewaze-modules/        # This repo
```

### Installation

```bash
pnpm install
```

### Type Checking and Building

```bash
# Type check all modules
pnpm typecheck

# Build all modules
pnpm build
```

## Making Changes

1. **Keep your fork up to date** before starting work:
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. **Make your changes** in a dedicated branch. Keep changes focused -- one feature or fix per branch.

3. **Verify your changes** pass all checks:
   ```bash
   pnpm typecheck
   pnpm build
   ```

4. **Push your branch** and open a pull request.

## Code Standards

### TypeScript

- All code must be written in **TypeScript**. Avoid `any` types; use proper type definitions.
- Use **interfaces** for object shapes and **type aliases** for unions and intersections.
- Export types from dedicated `types.ts` files within each module.

### Prettier

All code should be formatted consistently:

- Print width: 100
- Single quotes
- Trailing commas
- 2-space indentation

### File and Directory Naming

- Use **kebab-case** for file and directory names: `my-feature.ts`, `privacy-requests.tsx`.
- Use **PascalCase** for React component files when they export a single component: `EventCard.tsx`.
- Colocate tests next to source files: `my-feature.test.ts`.

### React

- Use **functional components** with hooks.
- Use **Radix Themes** components as the foundation for all UI elements.
- Keep components small and focused. Extract logic into custom hooks.

### SQL Migrations

- Use `IF NOT EXISTS` / `IF EXISTS` guards for idempotent migrations.
- Always enable Row Level Security (RLS) on new tables.
- Add appropriate RLS policies for service role and authenticated access.
- Prefix migration files with a sequential number: `001_`, `002_`, etc.

## Commit Message Format

This project follows the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type       | Description                                           |
|------------|-------------------------------------------------------|
| `feat`     | A new feature                                         |
| `fix`      | A bug fix                                             |
| `docs`     | Documentation changes only                            |
| `style`    | Code style changes (formatting, semicolons, etc.)     |
| `refactor` | Code changes that neither fix a bug nor add a feature |
| `perf`     | Performance improvements                              |
| `test`     | Adding or updating tests                              |
| `build`    | Changes to build system or external dependencies      |
| `ci`       | Changes to CI configuration                           |
| `chore`    | Other changes that don't modify src or test files     |

### Scopes

Use the module name as the scope: `events`, `compliance`, or `template`.

### Examples

```
feat(events): add bulk registration import
fix(compliance): correct consent record timestamp handling
docs: update module creation guide in README
refactor(events): extract attendance tracking into helper
```

### Rules

- Use the **imperative mood** in the description: "add feature" not "added feature."
- Do not capitalize the first letter of the description.
- Do not end the description with a period.
- Keep the first line under **72 characters**.
- Use the body to explain **what** and **why**, not how.

## Pull Request Process

1. **Open a pull request** against the `main` branch of the upstream repository.

2. **Fill out the PR template** with a description of your changes, related issues, and testing steps.

3. **Ensure all CI checks pass**, including:
   - Type checking
   - Build verification
   - CLA signature check

4. **Request a review** from a maintainer. At least one approval is required before merging.

5. **Address review feedback** by pushing additional commits to your branch. Do not force-push during review.

6. Once approved, a maintainer will **squash and merge** your PR.

### PR Guidelines

- Keep PRs small and focused. Large PRs are harder to review and more likely to have issues.
- Include screenshots or recordings for UI changes.
- Link related issues using GitHub keywords: `Closes #123`, `Fixes #456`.
- Update the README if your changes add a new module or modify existing module descriptions.

## Creating a Module

To create a new module:

1. Copy the template: `cp -r modules/_template modules/my-feature`
2. Update `package.json` with your module's name and description.
3. Update `index.ts` with your module's definition (ID, features, routes, migrations, etc.).
4. Add SQL migrations in `migrations/`.
5. Add admin UI components in `admin/`.

See the [README](./README.md#creating-a-module) for a detailed guide on module structure and the module definition API.

## Reporting Issues

When reporting a bug, please include:

- A clear and descriptive title
- Steps to reproduce the issue
- Expected behavior
- Actual behavior
- The module(s) affected
- Environment details (OS, Node.js version, browser)
- Screenshots or logs, if applicable

For feature requests, describe the problem you are trying to solve and your proposed solution.

---

Thank you for contributing to Gatewaze Modules! Your work helps build a better platform for everyone.
