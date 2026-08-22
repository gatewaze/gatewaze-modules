# Adopting an existing PR with the `agent:adopt` label

You can hand a pull request you developed locally to the Software Engineer module by applying the
`agent:adopt` label to it on GitHub. You do not need admin credentials. This does the same thing as
the admin's Connect action (`POST /prs/connect`): the module creates a `kind='external_pr'` run and
the pr-monitor starts watching the PR.

## How to use it

Open your PR as normal, then apply the `agent:adopt` label to it. You can also add the label while
creating the PR; the module handles it either way. The PR must be open, and it must live in a repo
that is connected to a project as a code repo. Re-applying the label to a PR that already has a
live run does nothing new; the module just re-checks the existing run.

On a deployment with several module instances, the bare `agent:adopt` label goes to the project's
primary instance. Use `agent:adopt@<instance>` to target a specific instance, the same way the
`agent:build@<instance>` trigger label works.

## Who can use it

The label only works when the person who applied it is in the project's allowed labellers list.
This is the same applier-trust rule the `agent:spec:provided` and `agent:model:*` labels use, with
one difference: because no run exists yet, an empty allowed labellers list means nobody can adopt.
The check uses who GitHub says applied the label, not the label's mere presence, so it cannot be
satisfied by editing the PR or its labels through another account. A label applied by anyone else
is ignored and logged. The module never posts an error comment on the PR for an untrusted label, so
re-applying it cannot create a comment loop.

## What an adopted run gets

The pr-monitor watches the PR and keeps the run's state current. When a trusted reviewer (an
allowed labeller, or the person who adopted the PR) requests changes or leaves inline comments,
the module runs a revise pass that addresses the feedback and pushes to the PR branch. This applies
to human reviewers and automated reviewers alike, as long as the account is trusted. When every PR
on the run is merged, the run completes and its review learnings are promoted to project memory.

Adopted runs deliberately get less than issue-triggered runs:

- No automatic CI-fix passes. A red check on an external PR never triggers a fix pass, because the
  branch is not agent-authored. A human pushes the fix, or a trusted reviewer requests the change
  in a review, which the revise pass then addresses.
- No auto-merge, in any autonomy mode. A human always merges an adopted PR.
- No issue bookkeeping. There is no triggering issue, so there are no status labels, no issue
  comments, and no spec to promote to memory.

See `provided-specs.md` for the labels that hand a locally-written spec to an issue-triggered run.
