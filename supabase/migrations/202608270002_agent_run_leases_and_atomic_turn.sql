-- Active Agent runs must be recoverable when a serverless invocation disappears.
alter table public.agent_runs
  add column if not exists lease_expires_at timestamptz;

-- Keep the lease alive at every durable checkpoint. The application supplies
-- the next state; this function remains the single atomic write boundary.
create or replace function public.create_agent_turn(
  p_task_id uuid,
  p_run_id uuid,
  p_working_document_id uuid,
  p_base_revision text,
  p_state jsonb,
  p_goal text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null or not exists (
    select 1 from public.tasks where id = p_task_id and owner_user_id = v_owner
  ) then raise exception 'TASK_NOT_FOUND' using errcode = 'P0002'; end if;

  insert into public.agent_runs (
    id, owner_user_id, task_id, working_document_id, base_revision,
    status, lock_version, state, lease_expires_at
  ) values (
    p_run_id, v_owner, p_task_id, p_working_document_id, p_base_revision,
    'queued', 0, p_state, now() + interval '2 minutes'
  );

  update public.tasks
    set goal = coalesce(p_goal, goal), updated_at = now()
    where id = p_task_id and owner_user_id = v_owner;

  return p_state;
end;
$$;

create or replace function public.reclaim_stale_agent_run(p_run_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare v_owner uuid := auth.uid();
begin
  update public.agent_runs
    set status = 'cancelled',
        error_code = 'STALE_RUN_RECOVERED',
        error_message = '运行租约已过期，已安全回收。',
        finished_at = now(), updated_at = now(), lease_expires_at = null
    where id = p_run_id and owner_user_id = v_owner
      and status in ('queued','analyzing','awaiting_scope_confirmation','generating','applying','validating','awaiting_review')
      and (lease_expires_at is null or lease_expires_at <= now());
  return found;
end;
$$;

revoke all on function public.create_agent_turn(uuid, uuid, uuid, text, jsonb, text) from public, anon;
revoke all on function public.reclaim_stale_agent_run(uuid) from public, anon;
grant execute on function public.create_agent_turn(uuid, uuid, uuid, text, jsonb, text) to authenticated;
grant execute on function public.reclaim_stale_agent_run(uuid) to authenticated;
