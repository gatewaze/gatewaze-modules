# Locally-authored specs (provided-spec intake)

You can write a spec yourself and hand it to the Software Engineer module through the issue that
triggers the run. The run then skips its own spec phase and its spec self-review phase, so those
phases are never billed.

## The two labels

- `agent:spec:provided`. The issue body carries the spec. Intake extracts it and stores it as the
  run's spec artifact, in the same shape the spec phase would have produced. The run then parks at
  the existing `awaiting_spec` human gate, even when the project's gates config has the spec gate
  turned off. A provided spec always gets the human gate because the adversarial self-review was
  skipped. You review the spec in the admin, refine it by chatting, and approve it, exactly as with
  an agent-written spec.
- `agent:spec:approved`. Apply this together with `agent:spec:provided` to also skip the human
  gate. The run goes straight to implementation with your spec. If the project has an architecture
  gate, the run goes through the architecture phase first, which is the same routing the admin's
  approve button uses. Applying `agent:spec:approved` without `agent:spec:provided` fails the run
  at intake.

The labels follow the same trust rule as the `agent:model:*` and `agent:engine:*` override labels.
Intake checks who applied each label through the issue's event history. A spec label counts only
when it was applied by the user who triggered the run, or by a user in the project's allowed
labellers list. A label applied by anyone else is ignored, and the run takes the normal
spec-authoring path. The extracted spec is treated as content only. It is never parsed as config,
labels, or commands, and the admin renders it through an escaping Markdown renderer.

## How to put the spec in the issue body

There are two supported formats.

1. Marker fence. Put the spec between two HTML comments:

   ```markdown
   Intro prose for human readers.

   <!-- se:spec -->
   # Goal
   Fix the widget renderer.

   # Approach
   Patch lib/render.ts and add a regression test.
   <!-- /se:spec -->
   ```

2. Heading. Put the spec under a `## Spec` heading. The section runs to the next `#` or `##`
   heading, or to the end of the body:

   ```markdown
   Intro prose for human readers.

   ## Spec
   Goal, approach, files to change, test plan, risks.

   ## Notes
   This section is not part of the spec.
   ```

When the markers are present they win, even if a `## Spec` heading also exists. An opening marker
without a closing marker is an error, not a fallback to the heading format.

## Failure cases

Intake fails the run, with the reason in the run view and in a comment on the issue, when:

- a spec label is present but the body has no extractable spec section,
- the spec section is empty,
- the spec is larger than 64KB,
- `agent:spec:approved` is applied without `agent:spec:provided`.

A failed intake never falls back to the billed spec phase. Fix the issue body or labels and
re-apply the trigger label to retry.
