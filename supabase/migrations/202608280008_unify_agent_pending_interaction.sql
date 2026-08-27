-- Unify runtime HITL checkpoints without changing the product-level
-- final_review interaction that remains owned by AgentRun.

create or replace function public.claim_agent_loop_interaction(
  p_run_id uuid,
  p_interaction_id text,
  p_interaction_type text,
  p_call_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_run public.agent_runs%rowtype;
  v_checkpoint jsonb;
  v_pending jsonb;
begin
  if p_interaction_type not in ('approval', 'user_input') then
    raise exception 'INTERACTION_TYPE_INVALID' using errcode = '22023';
  end if;

  select * into v_run
  from public.agent_runs
  where id = p_run_id and owner_user_id = v_owner
  for update;
  if not found then raise exception 'RUN_NOT_FOUND' using errcode = 'P0002'; end if;

  v_checkpoint := coalesce(v_run.state->'loopCheckpoint', '{}'::jsonb);
  v_pending := v_checkpoint->'pendingInteraction';
  if v_pending is null or v_pending = 'null'::jsonb then
    raise exception 'INTERACTION_ALREADY_CLAIMED' using errcode = '40001';
  end if;
  if v_pending->>'interactionId' <> p_interaction_id
    or v_pending->>'type' <> p_interaction_type
    or (p_interaction_type = 'approval' and v_pending->>'callId' <> p_call_id) then
    raise exception 'INTERACTION_MISMATCH' using errcode = '40001';
  end if;

  update public.agent_runs
  set state = jsonb_set(state, '{loopCheckpoint,pendingInteraction}', 'null'::jsonb, true)
          || jsonb_build_object('pendingInteraction', null),
      resume_cursor = jsonb_set(coalesce(resume_cursor, '{}'::jsonb), '{pendingInteraction}', 'null'::jsonb, true),
      status = 'running',
      lock_version = lock_version + 1,
      lease_expires_at = now() + interval '2 minutes',
      updated_at = now()
  where id = p_run_id and owner_user_id = v_owner
  returning state->'loopCheckpoint' into v_checkpoint;

  return v_checkpoint;
end;
$$;

revoke all on function public.claim_agent_loop_interaction(uuid, text, text, text) from public, anon;
grant execute on function public.claim_agent_loop_interaction(uuid, text, text, text) to authenticated;
