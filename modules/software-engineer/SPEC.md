# Software Engineer module — consolidated spec

> Supersedes the original `gatewaze/docs/spec-software-engineer.md`. This captures the
> model as it stands after the Phase 1 + Phase 2 build and the projects / ephemeral-engineer /
> issues-repo / multi-repo / memory evolution. Sections marked **BUILT** are implemented and
> verified on the local AAIF stack; **TO BUILD** is the remaining work.

## 1. Goal

Turn a labelled issue into merged (or proposed) pull requests by running a spec-first,
adversarially-reviewed, security-gated pipeline as in-process Claude Agent SDK sessions, inside
isolated git worktrees — "the same way a careful human engineer would." Works on any codebase with
GitHub access. Self-improving: the agents can work on Gatewaze's own repos.

## 1a. Resolved design decisions (adversarial review: GPT-5.1 + o1 + Gemini 2.5 + Claude)

Concrete rulings that close the gaps the review surfaced. These bind §2, §2.1, §7, §8, §12.5.

**Repo roles & bounds (§7).** `se_repos` gains `write_mode` (`writable` | `read_only`) and
`base_branch` (default = repo default). The agent may **read** every code repo but may **write only**
to `writable` ones — "agent picks" = picks among *writable* repos. `se_projects.max_code_repos_per_run`
(default 3) bounds the workspace; the agent is **told** which repos are present and whether any were
truncated, so it never specs against an absent repo — if a repo it needs is missing/truncated the run
goes `agent:blocked`. Each PR targets its repo's `base_branch`. Branch `agent/se-<issue>-<runid8>` is
unique per run (never reused); a run always cuts a fresh branch.

**Terminal states — resolve the Done contradiction (§2.1, §8).** Each of a run's PRs ends in
`merged` or `closed_unmerged` (tracked in `se_run_prs`; `merged`, `closed_unmerged`, `open` are
distinct — never conflate "closed"). The issue is **Done (closed) only when EVERY target PR is
merged.** If any target PR is `closed_unmerged`, the run → **`agent:blocked`** and the issue stays
**open** for a human to decide (accept the partial by closing it, or steer a re-do). A run is archived
on Done (all merged) or on explicit human close/cancel — **never** silently on a closed-unmerged PR.
Push/PR-create failure in one repo marks that repo's `se_run_prs` row `error` and blocks the run
(bounded retry first); it does **not** abort the repos that already succeeded.

**Single-valued status + drift (§2.1).** At most one of {`agent:build`, `agent:in-progress`,
`agent:in-review`, `agent:blocked`} is present at a time. The **run's DB status is authoritative for
its instance**; the issue label is a *projection* the run **re-asserts** on every reconcile (removing
stale/out-of-sequence `agent:*` labels a human or drift introduced, logging a warning). `agent:in-review`
is set when the first PR opens; if a later PR fails to create → `agent:blocked`.

**Human authority mid-run (§8).** If a human **closes the issue** or **removes all `agent:*` labels**
while a run is active, that is an authoritative **cancel**: the run stops, leaves any open PRs for the
human, and does not fight back by reopening. The run's **PR set is fixed** at the `pr` phase — the
watch tracks only the PRs it opened (in `se_run_prs`), never adopting human-opened PRs.

**Tasks↔GitHub loop prevention (§2).** Status labels (`agent:in-progress`/`in-review`/`blocked`) and
the closed state are **owned write-only by the SE run**; the Tasks mirror reflects them **read-only**
(GitHub→Tasks only) and **never writes status back**. The *only* Tasks→GitHub write is the
`agent:build` handoff (moving a card to "Ready for agent") + issue title/body. Mirror writes carry an
actor marker so the SE reconcile ignores changes it originated. If a human moves a card back to
"Ready" while a run is active (writing `agent:build`), the reconcile sees the active run and re-asserts
its real status (you can't re-queue an in-flight issue); cancel is done via the admin or by closing
the issue.

**Multi-instance claiming — corrected (§12.5).** Instances are **separate deployments with separate
databases**; they share **no datastore, only GitHub**, so a DB-transactional claim is impossible
cross-instance and coordination MUST go through GitHub. Therefore: **directed webhook delivery is the
primary guarantee** (only the configured instance receives the event → only it acts). The GitHub claim
is best-effort with **read-after-write**: remove the trigger label, add `agent:claimed@<instance>`,
re-read; if the claim isn't ours, abort. **No automatic leader election/failover** (no shared
coordinator exists) — failover is an **operational runbook** step (re-point the repo webhook + update
`primary_instance_id`). **Orphaned claims** (instance claimed then died) are reclaimable after a TTL
with no run progress. This is honest about the ceiling GitHub-only coordination imposes and acceptable
for an internal automation (not a five-nines HA requirement).

**Deliberate tradeoffs (not defects).** PAT-owner commits with no agent attribution is an intentional
product choice; **auditability is preserved via the run records** (`se_runs`/`se_phases`/`se_events`/
`se_artifacts`) + the admin dashboard + run↔PR↔issue links, not via git authorship. **Hardening
items** carried forward: route-level authZ + `is_admin` on the admin API is a hard pre-prod gate
(§13); prefer a dedicated least-privilege internal key over the service-role key for the wiki calls
(an AI-module concern SE inherits).

## 2. Entities

- **Brand / site** — the tenant boundary in the platform schema (`public.sites`). Gatewaze
  instances are **single-tenant**; multiple sites are *websites*, not tenants. `site_id` is retained
  on the `se_*` tables as an internal field only (RLS is `is_admin()`), and is **invisible in the UI**.
- **Project** — the persistent unit of configuration. Holds **all credentials** (GitHub PAT + Claude
  model credential), a **private issues repo**, **N code repos**, **shared memory**, **policy**
  (allowed labellers, autonomy, budgets), and a **concurrency cap** (`max_concurrent_engineers`).
- **Issues repo (the SE module's single work source)** — one, typically **private** repo per project
  where `agent:build` issues are filed. The SE module *only* watches GitHub issues here; it has no
  other source. Status sync: a comment on the issue with PR links (which the Tasks sync reflects back
  onto the Kanban).
  - **External** people (GitHub, no Gatewaze account) file issues directly here.
  - **Internal** Gatewaze people use the **Tasks board** (native Kanban, no GitHub), kept in
    **two-way sync with GitHub** (a `tasks`-module feature, not the SE module, reusing its
    `board_webhooks` + `task_webhook_outbox` with a `github` kind; a board links to the project's
    issues repo):
    - **Tasks → GitHub** (first increment): a task change creates/updates its issue; moving a task
      into the "Agent" status column adds `agent:build` → the SE webhook starts a run.
    - **GitHub → Tasks** (required for the status loop): the module watches the issue and mirrors its
      state onto the board columns. The **status source is the GitHub issue**, which the **SE run
      keeps current** — see §2.1 + §8.
    - **GitHub is the hub, not board↔board.** Every instance's board mirrors the *same* issues repo,
      so all instances (and all humans) converge **through GitHub** — no N×N board sync. A change on
      any instance's board writes to GitHub; every other instance's mirror reflects it. This is what
      makes it multi-instance-friendly (all instances see + can change status).
    - **Locked columns.** A GitHub-backed board's columns are fixed to the standardized status model
      (§2.1) — no renaming/reordering — because they must map to labels the SE run and other instances
      also write. (Free-form, non-mirrored boards keep custom columns.) One mirrored board per issues
      repo; an instance with several SE projects gets several boards (or one board with project
      swimlanes).
    - **Sequencing.** Build the GitHub side (issues repo + the §2.1 status model, set by the SE run)
      **now**; **hold the Tasks connection** for later. Everyone submits via GitHub directly in the
      meantime; the Tasks mirror slots on with no rework because the status model already exists.

  This keeps the SE module simple (GitHub issues only) and puts the GitHub sync where it belongs (the
  Tasks module, generally useful beyond SE). LFX still mirrors Jira into a private issues repo the
  team never sees.
- **Code repos** — the actual codebases the agent works in. A run may change one or several.
- **Engineer** — **ephemeral**: one per run, auto-named from a pool (Ada, Max, …) purely as a live
  UI label. Spawned per issue up to the project's concurrency cap, gone when the issue is done. No
  persistent engineer entity; no credentials at the engineer level.
- **Run** — one issue's lifecycle: a workspace of the project's code repos, the phase pipeline, the
  PR(s), and the two-way PR watch.

## 2.1 Standardized status model (the GitHub ↔ Kanban contract) (TO BUILD)

The status of a work item lives on its **GitHub issue** (state + a fixed `agent:*` label set) so it's
readable by the SE run, humans, other instances, and the future Tasks mirror. This is the single
lifecycle every surface agrees on; the SE run drives the transitions, humans may set them by moving a
card (which writes the label/state), and a GitHub-backed Kanban's **columns are locked to it**:

| Kanban column   | GitHub encoding                              | Set by |
|-----------------|----------------------------------------------|--------|
| Backlog         | open, no `agent:*` label                     | reporter / triage |
| Ready for agent | `agent:build` (optionally `@<instance>`, §12.5) | triage / human ("hand to agent") |
| In progress     | `agent:in-progress`                          | SE run (intake/spec/implement) |
| In review       | `agent:in-review` (PR open)                   | SE run (pr) |
| Blocked         | `agent:blocked` (needs a human)              | SE run (gate/failure) |
| Done            | issue **closed** (all PRs merged)            | SE run (merge) / human |

Orthogonal markers (not columns): `agent:claimed@<instance>` (ownership, §12.5). The issues repo is
provisioned with this label set; the SE run keeps it current (§8). Because the model is fixed,
mirrored boards across instances stay consistent without renaming drift.

## 3. Credentials & isolation (BUILT)

- All secrets on the **project**, AES-256-GCM sealed via `@gatewaze/shared/modules`
  (`sealToken`/`openToken`), only last-4 exposed. Git PAT + Claude model credential
  (`anthropic_api_key` | `claude_code_oauth_token` | `bedrock` | `vertex`).
- Isolation boundary: the `(repo) → project` mapping is the only path to a credential.
- Commits are authored as the **PAT owner** (derived from `GET /user`, cached on the project) so a
  PR reads as that person's own local work — no agent/Claude framing, no attribution trailer.
- Runner env is `process.env` minus secrets (`SENSITIVE_ENV` regex) plus exactly one model
  credential; the agent's tools never see other secrets.

## 4. Trigger (partly BUILT)

- **BUILT:** GitHub webhook (`/api/modules/software-engineer/internal/webhook`, JWT-exempt,
  HMAC-verified). `issues.labeled` `agent:build` → resolve repo → project → authorize → create a run.
- **TO BUILD:** resolve the issue's repo against the project's **issues_repo** (not the code repos).
  Only `agent:build` issues on the issues repo start runs. Trigger label configurable per project
  (default `agent:build`). Allowed labellers gate *who* can trigger.

## 5. Concurrency — ephemeral engineer pool (BUILT)

- Webhook creates the run `queued`. `dispatchProject` promotes queued runs to `running` while the
  project has a free slot (`≤ max_concurrent_engineers` active; active = running/watching/
  changes_requested/blocked/pr_open, archived excluded), assigning a pool name. Atomic
  queued→running guard prevents double-dispatch.
- Dispatch triggers: webhook, PR merged/closed, admin archive/cancel, and a 3-min `pr-monitor` cron
  `dispatchAll` safety-net. The server's worker concurrency is the global ceiling.

## 6. Phase pipeline (BUILT for single-repo; TO REWORK for multi-repo)

`intake → spec → review → implement → verify → pr → watch`, plus `revise` (PR-watch loop) and
`reflect` (memory). Each repo-touching phase runs an in-process Claude Agent SDK session
(`lib/agent-session.ts`): string prompt, `settingSources: []`, `permissionMode: 'default'` +
`canUseTool` allow (root-safe), CLAUDE.md/rules + project memory injected into `systemPrompt.append`,
Bash PreToolUse guard against `--no-verify`/`--force`/`rm -rf /`, live admin steering over Redis.

- **intake** — authorize + agent-contract precondition (CLAUDE.md present); ack the issue.
- **spec** — draft the implementation spec; adversarial **review** (actor ≠ judge) PASS/BLOCK loop.
- **implement** — make the change; compute blast radius (fail-closed).
- **verify** — security + language + error-handling validation (pragma).
- **pr** — open the PR(s); route to auto-merge (if eligible + `auto_merge_safe`) or `watching`.
- **watch / revise** — see §8.
- **reflect** — update project memory (§9).

## 7. Multi-repo run engine (TO BUILD) — the "agent picks" model

An issue lives on the issues repo but the work happens in the **code repos**. Chosen model:
**the agent has access to all code repos and decides where changes belong** (may touch several).

- **Workspace**: one temp dir with each enabled code repo cloned into `<workspace>/<repo>/` on a
  fresh agent branch (`agent/se-<issue>-<runid8>`, same name across repos). Agent cwd = workspace root.
- **Contract + memory injection**: each code repo's CLAUDE.md/rules injected, namespaced by repo;
  the project memory injected once.
- **spec**: agent explores across repos, writes a spec identifying target repo(s) + planned changes.
  Spec stored as a run artifact (DB) + included in each PR body — **not** committed into code repos.
- **implement**: agent edits across `<repo>/` subdirs.
- **detect targets**: after implement, `git status` per subdir → the changed repos are the targets.
- **verify**: per-repo (+ aggregate) gates.
- **pr**: for each changed repo → commit on its branch, push, open a PR. Collect all PR URLs; post a
  single comment on the **originating issue** (in the issues repo) linking every PR. `se_runs` tracks
  a set of PRs (new `se_run_prs` table, or a JSON column) rather than one `pr_number`.
- **watch/revise**: monitor **all** the run's PRs; changes-requested on any → revise (agent addresses
  across repos, re-pushes); a PR merged/closed updates that PR's state; when all are merged/closed →
  archive the run.
- **blast radius / autonomy**: computed per repo, aggregated to the run.

Guard: cap the number of code repos cloned per run (config) and `log()` if truncated.

## 8. Two-way PR watch (BUILT single-PR; TO EXTEND to multi-PR)

`pr-monitor` (3-min cron + webhook `pull_request`/`pull_request_review` nudges) reconciles each open
PR: merged/closed → archive (frees a slot → dispatch next); new CHANGES_REQUESTED / inline comments
since `pr_seen_at` → enqueue `revise` (**auto-address, unlimited rounds**); approved + eligible +
`auto_merge_safe` → merge; else stay `watching`. Extend to reconcile the *set* of a run's PRs per the
terminal-state rules in **§1a** (Done only when *all* merged; any closed-unmerged → `agent:blocked`;
human close = authoritative cancel; PR set fixed at the `pr` phase).

**Status reflection onto the issue (TO BUILD).** So the GitHub issue is the canonical status surface
the Tasks two-way sync (§2) mirrors onto the Kanban, the run keeps issue labels current: `agent:in-progress`
when a run picks the issue up (intake), `agent:in-review` when the first PR opens (pr), and it
**closes the issue** when all PRs merge (merge). Humans and the Tasks board read the same signal.

## 9. Memory — per-project, via the AI wiki (BUILT)

Durable, project-scoped engineering knowledge shared across the project's repos and every run.
Backed by the AI module's wiki over its JWT-exempt internal API (`/api/modules/ai/internal/wiki/*`,
`x-gatewaze-internal-key: SUPABASE_SERVICE_ROLE_KEY`). **Soft dependency** — no-ops if the AI module
is absent.

- **Recall** (BUILT): `phase-runner` reads the project's memory page and injects it into the system
  prompt for every phase.
- **Reflect** (BUILT): after the PR opens, a short no-worktree model turn distills the run into an
  updated memory doc and writes it back.
- **TO BUILD (follow-ups):** (a) import the operator's local `~/.claude/.../memory/` corpus into the
  project as many wiki pages; (b) upgrade recall from single-page read to **RAG search**
  (`/internal/wiki/search`), which motivates **one wiki use_case per project** so search is scoped;
  (c) rely on the AI module's git-sync for portability across installs.

## 10. MCP tools (TO BUILD — P3)

Give agents connected tools. Default **Gatewaze MCP** for every project (platform tools); per-project
opt-in servers (Jira, Slack, …) from the AI module's `ai_mcp_servers` (`bearer_token_ciphertext` +
headers). The SE worker resolves each to an Agent SDK `mcpServers` entry. OAuth token refresh is
owned by the AI module; the Gatewaze MCP needs a service/agent auth scope. LFX tie-in: an agent can
read the Jira ticket linked from the private GitHub issue for context.

## 10.5 Feedback intake & triage (TO BUILD)

Close the loop: let any signed-in admin report feedback from the page they're on, and turn rough
feedback into a well-formed ticket via a **triage agent** — distinct from the SE *code* agent.

- **Two entry points, one triage engine:**
  - **In-page widget** — a persistent "Report feedback" button in the Gatewaze admin UI (and the
    portal when signed in as admin). Inherently scoped to the **Gatewaze project** (it reports on the
    Gatewaze page you're on); seeded with **page context** (route, feature, optional screenshot).
  - **SE Issues-tab "New issue"** — the universal entry for **any project** (Gatewaze, LFX, …): pick
    the project, describe the problem, and the same triage agent runs. This is how you file work on
    projects whose UI you're not inside.
  Both reuse the **onboarding module's AI chat** panel pattern.
- **Triage agent**: an **AI-module use case driven by a goose recipe**. It converses, asks for
  missing detail, and emits a **structured ticket** (title, description, acceptance criteria, the
  project/area it touches, and whether it's an actionable code change).
- **Sink**: the triage output is written into the target project's **work source** — a Tasks board
  card or a GitHub issue — anchored to the feature/page. If actionable, it's flagged for an SE agent
  (Agent status column / `agent:build`), which then runs the normal pipeline → PR → status back to
  the ticket. So a non-technical admin's "this button is confusing" can become a merged fix.
- **Reuse**: onboarding chat (widget) + AI module use case/recipe (triage) + Tasks/GitHub (sink).
  Upstream of the SE pipeline; produces work items, doesn't write code.

## 11. Admin UI (BUILT; Issues tab TO BUILD)

Hero-header + tab shell (`WorkspaceLayout`). **URL-driven / deep-linkable**:

- `/software-engineer` → **Runs** (across all projects; project filter; live via Supabase realtime on
  se_runs/se_phases/se_events/se_messages; drill into a run for the live transcript + chat/steer/
  cancel/archive). **BUILT.**
- `/software-engineer/runs/<id>` → a specific run (shareable). **BUILT.**
- `/software-engineer/issues` → **Issues** — aggregates open issues from each project's issues repo,
  marks agent-targeted ones + run status, project filter. **TO BUILD.** Also a **"New issue"** button
  (project selector) that opens the **triage panel** (§10.5) — the universal, any-project entry
  point. Triage produces a structured ticket and the server writes it to the project's issues repo
  **via the project's PAT** (reporters need no GitHub account; the issue is authored under the
  project's identity). If flagged for an agent, it adds `agent:build` AND **directly creates +
  dispatches the run** (works on localhost, starts immediately). A no-triage
  `POST /admin/issues { project_id, title, body, assign_to_agent }` remains as the primitive the
  triage flow (and power users) call.
- `/software-engineer/setup` → **Setup** — project manager (creds, issues repo, code repos, policy,
  concurrency). **BUILT** (issues-repo field TO ADD).

## 12. Data model (BUILT + deltas)

- `se_projects` — creds, commit identity, policy, `max_concurrent_engineers`, memory-by-id.
  **TO ADD:** `issues_repo_owner`, `issues_repo_name`, `trigger_label` (default `agent:build`),
  `primary_instance_id` (which instance owns unqualified `agent:build`; §12.5),
  `max_code_repos_per_run` (default 3; §1a).
- `se_repos` — the project's **code repos** (`project_id`, enabled, contract_ok, branch_protection_ok,
  merge_eligible). (Issues repo moves to `se_projects`.) **TO ADD (§1a):** `write_mode`
  (`writable` | `read_only`), `base_branch` (default = repo default branch).
- `se_runs` — `project_id`, `engineer_name` (ephemeral), status/phase, blast_radius, tokens,
  `archived_at`, `revise_count`, `pr_state`, `pr_seen_at`, `pr_checked_at`. **TO ADD:** multi-PR
  tracking (`se_run_prs` table: run_id, repo_owner, repo_name, pr_number, pr_url, `state` ∈
  {`open`, `merged`, `closed_unmerged`, `error`}; §1a) replacing the single `pr_number`/`pr_url`;
  `instance_id` (which instance owns the run; §12.5).
- `se_phases`, `se_gates`, `se_events`, `se_messages`, `se_artifacts` — per-run pipeline records
  (realtime-published). Unchanged.

## 12.5 Multi-instance operation — work claiming (TO BUILD)

Multiple Gatewaze deployments may run the SE module against the **same** issues repos — e.g. AAIF
**prod** does the real work while a **localhost/dev** instance is used to develop the module itself,
or a second k8s cluster is brought up. Two instances must never both pick up the same issue.

- **Instance identity** — each deployment sets a stable `SE_INSTANCE_ID` (`aaif-prod`,
  `aaif-localhost`, …) + a human label; shown in the admin so you always know which instance you're
  looking at.
- **Directed delivery (the first-order guard)** — GitHub webhooks go to a *configured URL*. Prod owns
  the issues-repo webhook; **localhost is unreachable**, so GitHub cannot deliver events to it — it
  only runs via `simulate-webhook`. So there is no shared queue racing by default; delivery is
  directed. (Reassures the current localhost-vs-prod setup with no extra work.)
- **Targeted-label routing** — `agent:build` → the project's **primary** instance only;
  `agent:build@<instance-id>` → exactly that instance. Every instance's trigger check acts only on
  labels targeting *itself* (its id, or unqualified iff it is the project's primary) and ignores the
  rest — so a non-primary instance seeing `agent:build` does nothing, and prod ignores
  `agent:build@aaif-localhost`. This lets you develop on localhost against real repos with
  dev-targeted issues prod won't touch.
- **Primary per project** — `se_projects.primary_instance_id` designates the one instance that owns
  unqualified `agent:build`. In practice the primary is also the instance whose webhook is configured
  on the repo, so delivery + routing align.
- **Atomic claim (defense in depth)** — on pickup, an instance removes the trigger label and adds
  `agent:claimed@<instance>` before it starts, alongside the existing one-live-run-per-issue
  idempotency guard. GitHub label ops aren't transactional, so the claim is best-effort and the
  routing above is the primary guarantee; the claim resolves any residual race to a single owner and
  makes ownership visible on the issue.
- **Non-reachable instances** may optionally **poll** the issues repo for `agent:build@<their-id>`
  issues instead of relying on webhooks.
- **Shared memory across instances** — the wiki is per-instance; to share "Gatewaze wiki history"
  across clusters, the wiki **git-syncs to a shared repo** (§9 portability). A new instance pulls it
  and inherits the memory. Runs are per-instance; memory is shared via git.

Schema/config deltas: `SE_INSTANCE_ID` (deployment env); `se_projects.primary_instance_id`;
`se_runs.instance_id` (which instance owns a run).

## 13. Security

Per the repo working agreements: no secret in tracked source; allowlisted writable fields (no raw
`req.body`); sanitise before PostgREST `.or()`/SQL/ICS/URL; safe git via `execFile` argv only; module
admin API is JWT + `is_admin` gated by the platform (UI attaches the session Bearer). Every diff the
agents produce still passes the same review gates. **Open item:** the admin routes use the
service-role client and are not yet route-level authZ-gated beyond the platform JWT — harden before
any shared/prod deployment.

## 14. Build status

- **DONE + verified:** projects + all-creds-on-project; ephemeral engineer pool + concurrency;
  PAT-owner commits; single-repo pipeline; two-way PR watch + auto-archive; project memory
  (recall/reflect); real-time dashboard; run/setup URLs; project filter.
- **NEXT (this spec's deltas):** (1) issues-repo on the project + trigger against it; (2) multi-repo
  run engine (§7) + multi-PR tracking + watch; (3) Issues tab; then (4) memory import + RAG; (5) MCP.
