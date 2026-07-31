# Spec — Issue #42: Add a CODEOWNERS hint to the module template

## Goal

Make new-module authors aware, at the moment they scaffold a module, that
security-sensitive paths in their module are already covered by the repo's
`.github/CODEOWNERS` and that they may need a CODEOWNERS entry of their own.

Concretely: add a short, minimal **hint** to the module template
(`modules/_template/`) that points at `.github/CODEOWNERS`, so someone copying
the template to build `my-feature/` learns that:

- `/.github/CODEOWNERS` already globs `/modules/**/api/`,
  `/modules/**/functions/`, and `/modules/**/migrations/` to the
  `@gatewaze/maintainers` + `@gatewaze/security` teams — so any `api/`,
  `functions/`, or `migrations/` code they add will require code-owner review;
- if their module needs a specific owning team for its non-boundary paths, they
  should add a line to `.github/CODEOWNERS`.

This is a **doc/config note only** — no runtime code, no schema, no deps. "Keep
it minimal" is the explicit ask.

## Current state

- The module template lives at `modules/_template/` and contains
  `index.ts`, `package.json`, `tsconfig.json`, `admin/ExamplePage.tsx`,
  `migrations/001_example.sql`. **There is no README in `_template/`.**
- The canonical "how to use this template" guidance today is the JSDoc header
  block at the top of `modules/_template/index.ts` — a numbered list of steps
  ("1. Copy _template/ … 5. Add admin UI components in admin/").
- `.github/CODEOWNERS` already exists and already contains the relevant globs:
  ```
  /modules/**/functions/   @gatewaze/maintainers @gatewaze/security
  /modules/**/api/         @gatewaze/maintainers @gatewaze/security
  /modules/**/migrations/  @gatewaze/maintainers @gatewaze/security
  ```
  So the hint should *reference* this existing policy, not restate or duplicate
  the rules, and must not imply the author has to create CODEOWNERS from scratch.

## Approach

Preferred (smallest diff, no new file): **add the hint to the existing
`index.ts` header comment** in `modules/_template/index.ts`. Extend the numbered
steps with one item (and optionally a one-line note), e.g. append after the
existing "Add admin UI components in admin/" step:

```
 * 6. Review .github/CODEOWNERS: api/, functions/, and migrations/ paths in your
 *    module already require @gatewaze/maintainers + @gatewaze/security review.
 *    Add a CODEOWNERS line if your module needs its own owning team.
```

Keep wording short and factual; no secrets, no real emails, no team invented
beyond the two already present in CODEOWNERS. Reference the file by its
repo-relative path so it is greppable.

Alternative (only if a reviewer prefers a discoverable standalone doc): create a
tiny `modules/_template/README.md` with the same hint plus a one-line pointer to
`index.ts` for the full steps. This adds a file and mild duplication, so it is
**not** preferred for a "keep it minimal" issue — list it only as a fallback if
steered.

Decide between the two during review; default to editing `index.ts`.

## Files to change

- `modules/_template/index.ts` — extend the top-of-file JSDoc steps with the
  CODEOWNERS hint. **No change to the exported `templateModule` object**, its
  fields, imports, or behavior — comment-only edit.

No other files change. In particular:

- Do **not** modify `.github/CODEOWNERS` itself — it already has the globs, and
  `/.github/` is a security-owned path; editing it is out of this issue's scope.
- No `package.json`, `tsconfig.json`, migration, or admin-component changes.

## Test plan

Doc/comment-only change; validation is lightweight.

1. **Type-check unaffected:** `pnpm --filter @gatewaze-modules/template typecheck`
   (or repo-wide `pnpm -w tsc --noEmit`) stays clean — a JSDoc edit must not
   affect compilation.
2. **Accuracy check:** the paths named in the hint (`api/`, `functions/`,
   `migrations/`) exactly match the globs currently in `.github/CODEOWNERS`, and
   the team handles referenced match those in that file (`@gatewaze/maintainers`,
   `@gatewaze/security`). No invented team or email.
3. **Discoverability:** `grep -R "CODEOWNERS" modules/_template/` returns the new
   hint.
4. **No placeholder/secret regressions:** the added text contains no key, token,
   password, or real address — only team handles that already exist in the repo.

## Security review

Per CLAUDE.md, run `/security-review` (or the `pragma:security` skill) on the
branch diff before commit.

- The diff is a comment/doc addition with **no code path, no credential, no
  `req.body`, no `.or()`/SQL/ICS/URL construction, no shell** — no boundary is
  crossed. Expected result: clean.
- Confirm the added text ships **no real secret** (CLAUDE.md: example/template
  files carry placeholders only) — the hint uses only pre-existing public team
  handles, so this holds.
- Do not bypass the pre-push gitleaks gate; a doc-only change should pass it
  trivially.

## Risks

- **Very low** — comment-only edit to a template file; nothing executes.
- **Staleness:** if `.github/CODEOWNERS` globs later change, the hint could drift.
  Mitigate by keeping the hint pointer-style ("review `.github/CODEOWNERS`")
  rather than restating each rule, so the authoritative list stays single-sourced
  in CODEOWNERS.
- **Scope creep:** temptation to also edit `.github/CODEOWNERS` or add a full
  README. Both exceed "keep it minimal"; hold to the `index.ts` comment unless an
  admin steers otherwise.
