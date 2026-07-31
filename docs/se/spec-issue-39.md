# Spec — Issue #39: Note the security-review requirement in the module template README

## Goal

Make the repo's **security-review-before-commit** rule visible to anyone starting
a new module, by putting a short reminder in the module *template*. When a
contributor copies the template to create a module, the reminder travels with it.

Keep the change tiny and docs-only. No code, schema, API, or dependency changes.

## Current state (shapes the approach)

The module template lives at `modules/_template/` and is the canonical
"copy this to start a new module" starting point (see its `index.ts` header and
`package.json` `description`: *"Template module — copy this to create a new
Gatewaze module"*).

Its files today are:

- `modules/_template/index.ts` (manifest + a 5-step "copy this directory" comment)
- `modules/_template/package.json`
- `modules/_template/tsconfig.json`
- `modules/_template/admin/ExamplePage.tsx`
- `modules/_template/migrations/001_example.sql`

There is **no `README.md` in `modules/_template/`** (verified by listing the
directory). The issue title says "the module template README", but that file does
not exist yet. So satisfying the issue means **creating** a small
`modules/_template/README.md` that carries the reminder. Some sibling modules
have READMEs (e.g. `modules/analytics/README.md`), so a per-module README is an
established, consistent pattern.

The security-review rule the reminder points to is already the repo standard:

- `CLAUDE.md` → *"Every change that touches code gets a security pass before it is
  committed"*, run via `/security-review` (or the `pragma:security` skill /
  `/pragma:review`), reviewing the whole branch diff.
- `SECURITY.md` → reporting process; repo is open source and public.

The reminder should **link to** those existing docs rather than restate the whole
policy — keeps it small and avoids drift.

## Approach

Create `modules/_template/README.md` — short, following the tone of existing
module READMEs. Minimum viable content:

1. A one-line description of what the template is (mirrors `index.ts` /
   `package.json`: a starting point you copy to build a new Gatewaze module).
2. A brief pointer to the copy steps already documented in `index.ts` (don't
   duplicate them — reference the file so there's one source of truth).
3. **The required line** — the actual point of the issue — e.g.:

   > **Before you commit:** run a security review of your diff
   > (`/security-review`, the `pragma:security` skill, or `/pragma:review`) and
   > fix what it finds. Every change that touches code gets a security pass — see
   > [`CLAUDE.md`](../../CLAUDE.md) and [`SECURITY.md`](../../SECURITY.md).

Wording is illustrative; keep it to a sentence or two. Match the phrasing already
in `CLAUDE.md` so the two don't drift.

Optional (only if it reads naturally and stays small): add a one-line
"Security" note pointing to `CLAUDE.md` in the top-level `README.md` or
`CONTRIBUTING.md` too. **Recommend keeping scope to the template README only** —
the issue explicitly says "keep it small; follow the repo rules." Do not expand
without a steer.

### Relative-link check

From `modules/_template/README.md`, the repo root is two levels up, so links are
`../../CLAUDE.md` and `../../SECURITY.md`. Verify the paths resolve before commit.

## Files to change

- **New:** `modules/_template/README.md` — the only file created/changed.
- No changes to `index.ts`, `package.json`, migrations, or any other module.
- No dependency, schema, API, or CI-config changes.

## Test plan

Docs-only, so validation is lightweight:

1. **Link check:** confirm `../../CLAUDE.md` and `../../SECURITY.md` resolve from
   `modules/_template/README.md` (both exist at repo root).
2. **Markdown render:** eyeball the rendered README (headings, blockquote/list,
   links) — no broken markdown.
3. **Copy-flow sanity:** conceptually confirm that copying `modules/_template/`
   to a new module dir brings the README (and thus the reminder) along.
4. **No code impact:** `pnpm install` unaffected; no need to run `tsc` since no
   TS changed, but a repo typecheck should remain green.

## Security review

Per `CLAUDE.md`, run `/security-review` (or `pragma:security`) on the branch diff
before commit — including for a docs-only change.

- **No secrets.** The README must contain **no** real keys, tokens, passwords, or
  bearer values — placeholders only (repo is open source and public). This change
  adds only prose and relative doc links, so there is no credential surface.
- **No executable content** — no code, no `env || 'literal'` fallbacks, no
  `req.body`, no `.or()`/SQL/ICS/URL construction. Nothing for gitleaks or CodeQL
  to flag beyond the standard scan.
- The pre-push gitleaks gate and CI (gitleaks + CodeQL) still apply; do not
  bypass with `--no-verify`.

## Risks

- **Very low** — a single new documentation file, no runtime effect.
- **Broken relative links** if the `../../` depth is wrong — mitigated by the
  link check in the test plan.
- **Doc drift** — if the reminder restates the full policy it could fall out of
  sync with `CLAUDE.md`; mitigated by linking to `CLAUDE.md`/`SECURITY.md` rather
  than duplicating them.
- **Scope creep** — tempting to also touch top-level `README.md`/`CONTRIBUTING.md`;
  the issue asks to keep it small, so hold scope to the template README unless an
  admin steers otherwise.
