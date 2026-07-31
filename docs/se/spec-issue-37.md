# Spec — Issue #37: Add a short CONTRIBUTING note about the `agent:build` label

## Goal

Add a small, well-placed note to the contributor docs explaining what the
GitHub `agent:build` label does, so a contributor or maintainer who sees it on an
issue understands its effect. Keep it short (a few sentences / one small
subsection), docs-only, and consistent with the existing CONTRIBUTING.md tone.

## Current state (what the repo actually records today)

The label is **not documented or referenced anywhere in the repo**. Verified:

- `grep` for `agent:build` (and `agent:` / `agent.build`) across the tree — **no
  matches** in code, workflows, or markdown.
- `.github/workflows/` contains only `codeql.yml` and `gitleaks.yml`; neither
  reacts to issue labels. There is no label-triggered automation committed here.
- The only labels defined in-repo are in `.github/dependabot.yml`
  (`dependencies`, `ci`, `docker`) — unrelated.
- There is no `.github/ISSUE_TEMPLATE` or `PULL_REQUEST_TEMPLATE`.

Implication: the exact behavior of `agent:build` lives **outside** this repo
(org-level automation / an agent pipeline — this very branch is named
`agent/se-37-…`, consistent with an agent picking up labeled issues). Because the
repo does not define the mechanism, the note must describe the label's **purpose
and effect at a level we can state truthfully**, and must not invent a precise
trigger, workflow file, or guarantees that aren't committed here.

> **Open point for the admin/maintainer to confirm before/at implementation:**
> the one-line description of what `agent:build` triggers (e.g. "signals the
> automation to have an AI agent attempt an implementation branch/PR for the
> issue"). The draft below uses cautious, generic wording; replace with the
> authoritative sentence if provided. Do not overstate.

## Approach

Add a short subsection to **`CONTRIBUTING.md`**, placed at the end of the existing
**`## Reporting Issues`** section (that section already deals with issues and
labels-adjacent workflow, so it is the natural, discoverable home — no new
top-level section or Table of Contents churn needed for something this small).

Proposed content (wording to be confirmed with maintainer; keep it to ~3–5
lines):

```markdown
### The `agent:build` label

Maintainers may add the **`agent:build`** label to an issue to hand it to the
project's automated coding agent, which attempts an implementation and opens a
pull request for review. Adding the label is a maintainer action; a labeled
issue still goes through the normal [Pull Request Process](#pull-request-process)
— review and CI must pass before anything merges. If you are not a maintainer,
you do not need to add this label to contribute.
```

Notes for the implementer:

- Keep it factual and minimal. If the maintainer supplies the exact trigger
  sentence, use it verbatim; otherwise keep the hedged "attempts an
  implementation and opens a pull request for review" phrasing rather than
  promising specific behavior.
- Match existing style: `###` subsection heading, sentence case, backticked
  label name in **bold** on first mention, reference existing anchors with
  the same relative-link style already used in the file
  (e.g. `[CLA](./CLA.md)`, `[README](./README.md)`).
- Optional (only if it reads naturally): add a single line to the
  **Table of Contents** — but a `###` sub-item under an existing `##` section is
  typically fine to omit from the TOC, which currently lists only `##` sections.
  Prefer omitting to keep the change minimal.
- Do **not** create a new automation file, workflow, or label definition — the
  issue asks only for a documentation note.

## Files to change

- `CONTRIBUTING.md` — add the short subsection under `## Reporting Issues`.
  Single-file, documentation-only change.

No code, schema, migration, dependency, workflow, or config changes.

## Test plan

Documentation-only; no runtime tests apply.

1. **Render check:** preview `CONTRIBUTING.md` (GitHub markdown / local preview)
   — the new subsection renders under Reporting Issues, heading level is correct,
   the backticked/bold label displays, and any intra-doc links
   (`#pull-request-process`) resolve to real anchors.
2. **Link integrity:** confirm every anchor referenced exists in the file
   (`## Pull Request Process` → `#pull-request-process`).
3. **Prose/lint:** ensure formatting matches the file (line length is prose, not
   code; no trailing whitespace). No `pnpm typecheck`/`build` impact, but running
   them should remain green (they ignore markdown).
4. **Scope check:** `git diff --stat` shows only `CONTRIBUTING.md` touched.

## Security review

Per CLAUDE.md, every code-touching change gets a security pass; this change is
**markdown documentation only**, so the surface is minimal, but still verify:

- Run `/security-review` (or `pragma:security`) on the branch diff and report it
  ran clean.
- **No secrets:** the note must not include any token, key, URL with embedded
  credentials, internal endpoint, or bearer value — describe the label
  generically. This is a public repo; keep it placeholder/behavioral only.
- No `req.body`, SQL, `.or()` filters, ICS lines, shell calls, or constructed
  URLs are involved (nothing but prose).
- Do not name or link non-public internal automation infrastructure; describe the
  effect ("opens a PR for review"), not private system details.

## Commit / PR

- Conventional Commit type **`docs`** (no scope, or `docs(contributing)`), e.g.
  `docs: note the agent:build issue label in CONTRIBUTING`.
- Docs-only PR; CI (typecheck, build, gitleaks, CodeQL, CLA) should stay green.

## Risks

- **Low** — single-file documentation change, no code paths affected.
- **Accuracy risk (main one):** the label's real behavior is defined outside this
  repo. Overstating what it does (specific triggers, timing, guarantees) would be
  misleading. Mitigation: hedged wording above, and confirm the authoritative
  sentence with the maintainer/admin before finalizing.
- **Placement/scope creep:** resist expanding into a broader "AI agent workflow"
  section; the issue explicitly asks for a *short* note. Keep it to one small
  subsection.
