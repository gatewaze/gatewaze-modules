-- Pre-PR review phase (workers/pre-pr-review.ts): between implement and verify, the agent runs each
-- changed repo's OWN pre-PR review round and checks on the committed branch and lands the fixes,
-- so a pull request never opens on an unreviewed branch. Widen the enum CHECKs that name phases
-- and gates so the new phase and its gate can be recorded (see migration 015 for why a phase that
-- is missing here fails silently: the run never reaches it).
--
-- se_phases.phase also gains every phase name the workers already record today but 015 never
-- listed (revise, reflect, interactive, the three refine turns, and the cheap utility turns), and
-- se_gates.gate gains the cost_ceiling (blockRun since migration 014) and provided_spec (intake)
-- gates that 001's inline check never allowed. Those inserts have been failing the constraint
-- silently (supabase-js returns the error, the writers do not read it). Idempotent (drop-if-exists
-- then add).
alter table public.se_runs drop constraint if exists se_runs_current_phase_check;
alter table public.se_runs add constraint se_runs_current_phase_check
  check (current_phase = any (array[
    'intake','spec','review','architecture','implement','pre-pr-review','verify','pr','merge','revise','reflect','watch','interactive'
  ]));

alter table public.se_phases drop constraint if exists se_phases_phase_check;
alter table public.se_phases add constraint se_phases_phase_check
  check (phase = any (array[
    'intake','spec','review','architecture','implement','pre-pr-review','verify','pr','merge','revise','reflect','interactive',
    'spec-refine','architecture-refine','code-refine',
    'triage','ci-classify','decision-distill','reporter-summary-distill','review_kb'
  ]));

alter table public.se_gates drop constraint if exists se_gates_gate_check;
alter table public.se_gates add constraint se_gates_gate_check
  check (gate = any (array[
    'authorization','adversarial_review','pre_pr_review','security','ci','blast_radius','budget','kill_switch','cost_ceiling','provided_spec'
  ]));
