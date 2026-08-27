-- Agent runs are model-driven executions. Activity such as model/tool work is
-- represented by events, never by a fixed analyze/generate/apply/validate phase.
alter table public.agent_runs drop constraint if exists agent_runs_status_check;
alter table public.agent_runs add constraint agent_runs_status_check
  check (status in ('queued', 'running', 'awaiting_approval', 'awaiting_user', 'awaiting_review', 'completed', 'failed', 'cancelled'));

drop index if exists public.agent_runs_one_active_per_task_idx;
create unique index agent_runs_one_active_per_task_idx
  on public.agent_runs(task_id)
  where status in ('queued', 'running', 'awaiting_approval', 'awaiting_user', 'awaiting_review');

create index if not exists agent_runs_status_idx
  on public.agent_runs(status)
  where status in ('queued', 'running', 'awaiting_approval', 'awaiting_user', 'awaiting_review');

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
        state = jsonb_set(
          jsonb_set(coalesce(state, '{}'::jsonb), '{status}', '"cancelled"'::jsonb, true),
          '{loopCheckpoint,status}', '"cancelled"'::jsonb, true
        ),
        error_code = 'STALE_RUN_RECOVERED',
        error_message = '运行租约已过期，已安全回收。',
        finished_at = now(), updated_at = now(), lease_expires_at = null
    where id = p_run_id and owner_user_id = v_owner
      and status in ('queued', 'running')
      and (lease_expires_at is null or lease_expires_at <= now());
  return found;
end;
$$;
