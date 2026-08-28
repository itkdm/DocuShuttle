-- Final Review is not an Agent Runtime state. Normalize any historical
-- development rows before removing it from the lifecycle constraint/indexes.
update public.agent_runs
set status = 'completed',
    state = jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(coalesce(state, '{}'::jsonb), '{status}', '"completed"'::jsonb, true),
            '{loopCheckpoint,status}', '"completed"'::jsonb, true
          ),
          '{loopCheckpoint,pendingInteraction}', 'null'::jsonb, true
        ),
        '{loopCheckpoint,pendingResolution}', 'null'::jsonb, true
      ),
      '{pendingInteraction}', 'null'::jsonb, true
    ) || jsonb_build_object('pendingResolution', null),
    resume_cursor = jsonb_set(
      jsonb_set(coalesce(resume_cursor, '{}'::jsonb), '{status}', '"completed"'::jsonb, true),
      '{pendingInteraction}', 'null'::jsonb, true
    ),
    lease_expires_at = null,
    finished_at = coalesce(finished_at, now()),
    updated_at = now()
where status = 'awaiting_review';

alter table public.agent_runs drop constraint if exists agent_runs_status_check;
alter table public.agent_runs add constraint agent_runs_status_check
  check (status in ('queued', 'running', 'awaiting_approval', 'awaiting_user', 'completed', 'failed', 'cancelled'));

drop index if exists public.agent_runs_one_active_per_task_idx;
create unique index agent_runs_one_active_per_task_idx
  on public.agent_runs(task_id)
  where status in ('queued', 'running', 'awaiting_approval', 'awaiting_user');

drop index if exists public.agent_runs_status_idx;
create index agent_runs_status_idx
  on public.agent_runs(status)
  where status in ('queued', 'running', 'awaiting_approval', 'awaiting_user');
