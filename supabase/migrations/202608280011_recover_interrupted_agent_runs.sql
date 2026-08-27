create or replace function public.claim_agent_run_recovery(p_run_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_run public.agent_runs%rowtype;
begin
  select * into v_run
  from public.agent_runs
  where id = p_run_id and owner_user_id = v_owner
  for update;

  if not found then
    raise exception 'RUN_NOT_FOUND';
  end if;
  if v_run.status <> 'running' then
    return null;
  end if;
  if v_run.lease_expires_at is not null and v_run.lease_expires_at > now() then
    raise exception 'RUN_STILL_ACTIVE';
  end if;

  update public.agent_runs
  set lease_expires_at = now() + interval '2 minutes',
      lock_version = lock_version + 1,
      updated_at = now()
  where id = p_run_id and owner_user_id = v_owner;

  return v_run.state->'loopCheckpoint';
end;
$$;

create or replace function public.release_agent_run_recovery_lease(p_run_id uuid)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  update public.agent_runs
  set lease_expires_at = null, updated_at = now()
  where id = p_run_id and owner_user_id = auth.uid() and status = 'running'
  returning true;
$$;

revoke all on function public.claim_agent_run_recovery(uuid) from public;
revoke all on function public.release_agent_run_recovery_lease(uuid) from public;
grant execute on function public.claim_agent_run_recovery(uuid) to authenticated;
grant execute on function public.release_agent_run_recovery_lease(uuid) to authenticated;
