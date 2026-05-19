-- tasks module — 015 — triggers (spec §11).
--
-- All trigger functions live in the `public` schema so RLS policies can
-- reference them via fully-qualified names. Functions use SECURITY
-- INVOKER (default) so RLS applies to their queries.

-- ============================================================
-- T1: tasks.is_done mirror — keeps the denorm flag in sync.
-- ============================================================
create or replace function tasks_t_sync_is_done() returns trigger
language plpgsql as $$
begin
  if new.status_id is null then
    new.is_done := false;
    new.completed_at := null;
    return new;
  end if;
  select is_done_state into new.is_done
    from public.board_statuses where id = new.status_id;
  if new.is_done and not coalesce(old.is_done, false) then
    new.completed_at := now();
  elsif not new.is_done then
    new.completed_at := null;
  end if;
  return new;
end $$;

drop trigger if exists tasks_b_iu_sync_is_done on public.tasks;
create trigger tasks_b_iu_sync_is_done
  before insert or update of status_id on public.tasks
  for each row execute function tasks_t_sync_is_done();

-- ============================================================
-- T2: parent auto-completion (when board.parent_completion=auto).
-- ============================================================
create or replace function tasks_t_parent_rollup() returns trigger
language plpgsql as $$
declare
  v_mode text;
  v_parent_id uuid;
  v_done_status_id uuid;
  v_open_count int;
begin
  if new.parent_task_id is null then return new; end if;
  if new.is_done is not true or coalesce(old.is_done, false) is true then return new; end if;
  select parent_completion into v_mode from public.task_boards where id = new.board_id;
  if v_mode <> 'auto' then return new; end if;
  v_parent_id := new.parent_task_id;
  select count(*) into v_open_count
    from public.tasks
   where parent_task_id = v_parent_id
     and deleted_at is null
     and is_done = false
     and id <> new.id;
  if v_open_count > 0 then return new; end if;
  select id into v_done_status_id from public.board_statuses
   where board_id = new.board_id and is_done_state = true
   order by sort_index limit 1;
  if v_done_status_id is null then return new; end if;
  -- Set the parent's status to a done state. T1 will mirror is_done
  -- from the new status. T2 owns status_id; T1 owns is_done; we don't
  -- add `where is_done = false` here to avoid races with concurrent T1.
  update public.tasks set status_id = v_done_status_id where id = v_parent_id;
  insert into public.task_activity (task_id, actor_id, event_type, payload)
    values (v_parent_id, null, 'auto_completed_parent', jsonb_build_object('child_task_id', new.id));
  return new;
end $$;

drop trigger if exists tasks_a_u_parent_rollup on public.tasks;
create trigger tasks_a_u_parent_rollup
  after update of is_done on public.tasks
  for each row execute function tasks_t_parent_rollup();

-- ============================================================
-- T3: activity-log diff writer.
-- ============================================================
create or replace function tasks_t_log_activity() returns trigger
language plpgsql as $$
declare
  v_actor uuid;
begin
  begin
    v_actor := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  exception when others then
    v_actor := null;
  end;
  if old.title is distinct from new.title then
    insert into public.task_activity (task_id, actor_id, event_type, payload)
      values (new.id, v_actor, 'title_changed',
              jsonb_build_object('from', old.title, 'to', new.title));
  end if;
  if old.description is distinct from new.description then
    insert into public.task_activity (task_id, actor_id, event_type, payload)
      values (new.id, v_actor, 'description_changed',
              jsonb_build_object(
                'from_length', coalesce(length(old.description), 0),
                'to_length',   coalesce(length(new.description), 0)
              ));
  end if;
  if old.status_id is distinct from new.status_id then
    insert into public.task_activity (task_id, actor_id, event_type, payload)
      values (new.id, v_actor, 'status_changed',
              jsonb_build_object('from', old.status_id, 'to', new.status_id));
  end if;
  if old.assignee_id is distinct from new.assignee_id then
    insert into public.task_activity (task_id, actor_id, event_type, payload)
      values (new.id, v_actor, 'assignee_changed',
              jsonb_build_object('from', old.assignee_id, 'to', new.assignee_id));
  end if;
  if old.priority is distinct from new.priority then
    insert into public.task_activity (task_id, actor_id, event_type, payload)
      values (new.id, v_actor, 'priority_changed',
              jsonb_build_object('from', old.priority, 'to', new.priority));
  end if;
  if old.estimate_hours is distinct from new.estimate_hours then
    insert into public.task_activity (task_id, actor_id, event_type, payload)
      values (new.id, v_actor, 'estimate_changed',
              jsonb_build_object('from', old.estimate_hours, 'to', new.estimate_hours));
  end if;
  if old.start_date is distinct from new.start_date then
    insert into public.task_activity (task_id, actor_id, event_type, payload)
      values (new.id, v_actor, 'start_date_changed',
              jsonb_build_object('from', old.start_date, 'to', new.start_date));
  end if;
  if old.due_date is distinct from new.due_date then
    insert into public.task_activity (task_id, actor_id, event_type, payload)
      values (new.id, v_actor, 'due_date_changed',
              jsonb_build_object('from', old.due_date, 'to', new.due_date));
  end if;
  if old.parent_task_id is distinct from new.parent_task_id then
    insert into public.task_activity (task_id, actor_id, event_type, payload)
      values (new.id, v_actor, 'parent_changed',
              jsonb_build_object('from', old.parent_task_id, 'to', new.parent_task_id));
  end if;
  if old.deleted_at is null and new.deleted_at is not null then
    insert into public.task_activity (task_id, actor_id, event_type, payload)
      values (new.id, v_actor, 'soft_deleted', jsonb_build_object());
  elsif old.deleted_at is not null and new.deleted_at is null then
    insert into public.task_activity (task_id, actor_id, event_type, payload)
      values (new.id, v_actor, 'restored', jsonb_build_object());
  end if;
  return new;
end $$;

drop trigger if exists tasks_a_u_log_activity on public.tasks;
create trigger tasks_a_u_log_activity
  after update on public.tasks
  for each row when (old.* is distinct from new.*)
  execute function tasks_t_log_activity();

-- ============================================================
-- T4: comment fanout — mentions + followers + activity row.
-- ============================================================
create or replace function tasks_t_fanout_mentions() returns trigger
language plpgsql as $$
declare
  v_recipient uuid;
  v_board_id uuid;
begin
  select board_id into v_board_id from public.tasks where id = new.task_id;
  if new.mentions is not null then
    foreach v_recipient in array new.mentions loop
      if exists (select 1 from public.board_members
                  where board_id = v_board_id and admin_profile_id = v_recipient)
         and coalesce((select notify_on_mention from public.task_user_prefs
                        where admin_profile_id = v_recipient), true) then
        insert into public.task_notifications (recipient_id, task_id, kind, payload)
          values (v_recipient, new.task_id, 'mentioned',
                  jsonb_build_object('source_comment_id', new.id, 'author_id', new.author_id));
      end if;
    end loop;
  end if;

  -- comment_on_followed: prior commenters OR task assignee. Excludes
  -- the author and anyone already mentioned (they get 'mentioned').
  insert into public.task_notifications (recipient_id, task_id, kind, payload)
    select distinct r.id, new.task_id, 'comment_on_followed',
           jsonb_build_object('source_comment_id', new.id, 'author_id', new.author_id)
      from (
        select author_id as id from public.task_comments where task_id = new.task_id
        union
        select assignee_id from public.tasks where id = new.task_id and assignee_id is not null
      ) r
     where r.id is not null
       and r.id <> new.author_id
       and r.id <> all(coalesce(new.mentions, '{}'::uuid[]))
       and exists (select 1 from public.board_members
                    where board_id = v_board_id and admin_profile_id = r.id)
       and coalesce((select notify_on_followed_change from public.task_user_prefs
                      where admin_profile_id = r.id), true);

  insert into public.task_activity (task_id, actor_id, event_type, payload)
    values (new.task_id, new.author_id, 'comment_added', jsonb_build_object('comment_id', new.id));
  return new;
end $$;

drop trigger if exists task_comments_a_i_fanout on public.task_comments;
create trigger task_comments_a_i_fanout
  after insert on public.task_comments
  for each row execute function tasks_t_fanout_mentions();

-- ============================================================
-- T5: assignment fanout (notify new assignee).
-- ============================================================
create or replace function tasks_t_fanout_assignee() returns trigger
language plpgsql as $$
begin
  if (tg_op = 'INSERT' and new.assignee_id is not null)
     or (tg_op = 'UPDATE' and old.assignee_id is distinct from new.assignee_id and new.assignee_id is not null) then
    if coalesce((select notify_on_assignment from public.task_user_prefs
                  where admin_profile_id = new.assignee_id), true) then
      insert into public.task_notifications (recipient_id, task_id, kind, payload)
        values (new.assignee_id, new.id, 'assigned',
                jsonb_build_object('actor_id',
                  nullif(current_setting('request.jwt.claim.sub', true), '')));
    end if;
  end if;
  return new;
end $$;

drop trigger if exists tasks_a_iu_fanout_assignee on public.tasks;
create trigger tasks_a_iu_fanout_assignee
  after insert or update of assignee_id on public.tasks
  for each row execute function tasks_t_fanout_assignee();

-- ============================================================
-- T6: hard-dependency guard (rejects status flip when blockers open).
-- ============================================================
create or replace function tasks_t_hard_dep_guard() returns trigger
language plpgsql as $$
declare
  v_mode text;
  v_new_is_done bool;
  v_open_blocker_ids uuid[];
begin
  if new.status_id is null or old.status_id is not distinct from new.status_id then
    return new;
  end if;
  select dependency_mode into v_mode from public.task_boards where id = new.board_id;
  if v_mode <> 'hard' then return new; end if;
  select is_done_state into v_new_is_done from public.board_statuses where id = new.status_id;
  if v_new_is_done then return new; end if;
  select coalesce(array_agg(blocker.id), '{}'::uuid[]) into v_open_blocker_ids
    from public.task_dependencies d
    join public.tasks blocker on blocker.id = d.blocker_id
   where d.blocked_id = new.id
     and blocker.is_done = false
     and blocker.deleted_at is null;
  if array_length(v_open_blocker_ids, 1) is not null then
    raise exception 'dependency_blocked'
      using errcode = '23514',
            detail = jsonb_build_object('open_blockers', v_open_blocker_ids)::text;
  end if;
  return new;
end $$;

drop trigger if exists tasks_b_u_hard_dep_guard on public.tasks;
create trigger tasks_b_u_hard_dep_guard
  before update of status_id on public.tasks
  for each row execute function tasks_t_hard_dep_guard();

-- ============================================================
-- T7: webhook outbox enqueue.
-- ============================================================
create or replace function tasks_t_webhook_enqueue() returns trigger
language plpgsql as $$
declare
  v_event text;
  v_board_id uuid;
  v_payload jsonb;
  w record;
begin
  if tg_op = 'INSERT' and tg_table_name = 'tasks' then
    v_event := 'task.created';
    v_board_id := new.board_id;
    v_payload := jsonb_build_object('task_id', new.id, 'title', new.title);
  elsif tg_op = 'UPDATE' and tg_table_name = 'tasks' then
    v_board_id := coalesce(new.board_id, old.board_id);
    if old.deleted_at is null and new.deleted_at is not null then
      v_event := 'task.deleted';
      v_payload := jsonb_build_object('task_id', new.id);
    elsif coalesce(old.is_done, false) = false and new.is_done = true then
      v_event := 'task.completed';
      v_payload := jsonb_build_object('task_id', new.id);
    elsif old.assignee_id is distinct from new.assignee_id then
      v_event := 'task.assigned';
      v_payload := jsonb_build_object('task_id', new.id, 'assignee_id', new.assignee_id);
    else
      return null;
    end if;
  elsif tg_op = 'INSERT' and tg_table_name = 'task_comments' then
    v_event := 'comment.posted';
    v_payload := jsonb_build_object('task_id', new.task_id, 'comment_id', new.id);
    select board_id into v_board_id from public.tasks where id = new.task_id;
  else
    return null;
  end if;
  for w in
    select id from public.board_webhooks
     where board_id = v_board_id
       and active = true
       and v_event = any(events)
  loop
    insert into public.task_webhook_outbox (webhook_id, event_type, payload)
      values (w.id, v_event, v_payload);
  end loop;
  return null;
end $$;

drop trigger if exists tasks_a_i_webhook_enqueue on public.tasks;
create trigger tasks_a_i_webhook_enqueue
  after insert on public.tasks
  for each row execute function tasks_t_webhook_enqueue();

drop trigger if exists tasks_a_u_webhook_enqueue on public.tasks;
create trigger tasks_a_u_webhook_enqueue
  after update on public.tasks
  for each row when (old.* is distinct from new.*)
  execute function tasks_t_webhook_enqueue();

drop trigger if exists task_comments_a_i_webhook_enqueue on public.task_comments;
create trigger task_comments_a_i_webhook_enqueue
  after insert on public.task_comments
  for each row execute function tasks_t_webhook_enqueue();

-- ============================================================
-- T8: dependency cycle guard.
-- ============================================================
create or replace function tasks_t_dep_cycle_guard() returns trigger
language plpgsql as $$
declare
  v_found int;
begin
  with recursive reach(id) as (
    select new.blocked_id
    union
    select d.blocked_id from public.task_dependencies d
      join reach r on d.blocker_id = r.id
  )
  select count(*) into v_found from reach where id = new.blocker_id;
  if v_found > 0 then
    raise exception 'cycle_detected'
      using errcode = '23514',
            detail = jsonb_build_object('blocker', new.blocker_id, 'blocked', new.blocked_id)::text;
  end if;
  return new;
end $$;

drop trigger if exists task_dependencies_b_i_cycle on public.task_dependencies;
create trigger task_dependencies_b_i_cycle
  before insert on public.task_dependencies
  for each row execute function tasks_t_dep_cycle_guard();

-- ============================================================
-- T9: parent cycle guard.
-- ============================================================
create or replace function tasks_t_parent_cycle_guard() returns trigger
language plpgsql as $$
declare
  v_found int;
begin
  if new.parent_task_id is null then return new; end if;
  with recursive anc(id) as (
    select new.parent_task_id
    union
    select t.parent_task_id from public.tasks t
      join anc on t.id = anc.id
     where t.parent_task_id is not null
  )
  select count(*) into v_found from anc where id = new.id;
  if v_found > 0 then
    raise exception 'parent_cycle_detected' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists tasks_b_iu_parent_cycle on public.tasks;
create trigger tasks_b_iu_parent_cycle
  before insert or update of parent_task_id on public.tasks
  for each row execute function tasks_t_parent_cycle_guard();

-- ============================================================
-- T10: updated_at maintainer.
-- ============================================================
create or replace function tasks_t_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists task_boards_b_u_touch on public.task_boards;
create trigger task_boards_b_u_touch  before update on public.task_boards   for each row execute function tasks_t_touch();
drop trigger if exists tasks_b_u_touch on public.tasks;
create trigger tasks_b_u_touch        before update on public.tasks         for each row execute function tasks_t_touch();
drop trigger if exists task_comments_b_u_touch on public.task_comments;
create trigger task_comments_b_u_touch before update on public.task_comments for each row execute function tasks_t_touch();
drop trigger if exists task_field_values_b_u_touch on public.task_field_values;
create trigger task_field_values_b_u_touch before update on public.task_field_values for each row execute function tasks_t_touch();
