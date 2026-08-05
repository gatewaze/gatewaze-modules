-- The §7.6 architecture-review gate (migration 012 / #118) introduced a new phase `architecture` and a
-- new run status `awaiting_architecture`, but did NOT widen the CHECK constraints that enumerate the
-- allowed values — so review.ts's `current_phase='architecture'` update and the architecture worker's
-- `status='awaiting_architecture'` update both silently failed the constraint (the run never reached
-- the gate; it looped). Widen all three enum-CHECKs to include the new values. Idempotent
-- (drop-if-exists then add); matches what was applied out-of-band on aaif-staging.
alter table public.se_runs drop constraint if exists se_runs_current_phase_check;
alter table public.se_runs add constraint se_runs_current_phase_check
  check (current_phase = any (array[
    'intake','spec','review','architecture','implement','verify','pr','merge','revise','reflect','watch','interactive'
  ]));

alter table public.se_runs drop constraint if exists se_runs_status_check;
alter table public.se_runs add constraint se_runs_status_check
  check (status = any (array[
    'queued','running','blocked','failed','pr_open','watching','changes_requested','merged','closed','cancelled','awaiting_architecture'
  ]));

alter table public.se_phases drop constraint if exists se_phases_phase_check;
alter table public.se_phases add constraint se_phases_phase_check
  check (phase = any (array['intake','spec','review','architecture','implement','verify','pr','merge']));
