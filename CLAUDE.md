# Gatewaze modules — working agreement for AI coding agents

Loaded automatically at session start. Applies to everyone working in this repo.
This repo is **open source and public** — extra care with anything secret.

## Security is part of every task

Every change that touches code gets a security pass before it is committed —
not only "security work". A module edge function or API handler crosses auth and
data-access boundaries just like the core platform does.

Before you commit code you wrote or modified:

1. Run a security review of the diff (`/security-review`, or the `pragma:security`
   skill, or `/pragma:review`). Review the whole branch diff on a multi-commit
   branch, not just the last commit.
2. Watch the high-frequency boundaries: never hardcode a credential (not even as
   an `env || 'literal'` fallback — that ships a real secret and can open an auth
   bypass); allowlist writable fields instead of inserting `req.body`; sanitise
   user input before it reaches a PostgREST `.or()` filter, SQL, an ICS line, or
   a constructed URL; validate enums/string-unions; rate-limit public POSTs.
3. Fix what you find, re-run until clean, and report what you checked.

## Commit and push

- A **blocking pre-push secret gate** lives in `.githooks/pre-push` (gitleaks over
  the pushed commits). Enable it once per clone:
  `git config core.hooksPath .githooks` — and install gitleaks
  (`brew install gitleaks`). Do not routinely bypass it with `--no-verify`.
- CI (`.github/workflows/`) runs gitleaks and CodeQL on every push and PR; green
  is required to merge.

## Never do these

- Never commit a real secret — keys, tokens, passwords, or bearer values — in
  source, tests, READMEs, or example files. Example files carry placeholders only.
- Never insert `req.body` directly; use a writable-field allowlist.
- Never add a raw shell call built from user input.
- Never import `@radix-ui/themes` directly inside a module file — it duplicates
  the Radix singleton in production builds and crashes `useThemeContext`.
- Never disable a rule or CI gate to make a change pass. Fix the code.

## Setup for a fresh clone

Trust the workspace so the `gatewaze-skills` + `pragma` plugins auto-install from
committed `.claude/settings.json`. Then `pnpm install`, `brew install gitleaks`,
and `git config core.hooksPath .githooks`. See `SECURITY.md` to report a
vulnerability.
