-- Human-in-the-loop waits are not stale invocations. Keep them reclaimable
-- only through their explicit approval/answer/cancel path.
create or replace function public.reclaim_stale_agent_run(p_run_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare v_owner uuid := auth.uid();
begin
  update public.agent_runs
    set status = 'cancelled', error_code = 'STALE_RUN_RECOVERED',
        error_message = '运行租约已过期，已安全回收。', finished_at = now(),
        updated_at = now(), lease_expires_at = null
    where id = p_run_id and owner_user_id = v_owner
      and status in ('queued','analyzing','generating','applying','validating')
      and (lease_expires_at is null or lease_expires_at <= now());
  return found;
end;
$$;
