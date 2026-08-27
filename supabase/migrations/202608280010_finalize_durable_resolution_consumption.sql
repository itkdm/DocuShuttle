-- Finalize durable interaction resolution without editing the already-applied
-- 009 migration. Approval retries compare identity and decision, not the
-- canonical tool payload that the database adds to the stored resolution.

create or replace function public.resolve_agent_loop_interaction(
  p_run_id uuid,
  p_interaction_id text,
  p_interaction_type text,
  p_call_id text default null,
  p_resolution jsonb default '{}'::jsonb
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
  v_resolution jsonb;
  v_next_checkpoint jsonb;
begin
  if p_interaction_type not in ('approval', 'user_input') then
    raise exception 'INTERACTION_TYPE_INVALID' using errcode = '22023';
  end if;
  if p_resolution->>'interactionId' <> p_interaction_id
    or p_resolution->>'type' <> p_interaction_type then
    raise exception 'INTERACTION_RESOLUTION_INVALID' using errcode = '22023';
  end if;
  if p_interaction_type = 'approval'
    and (p_resolution->>'callId' is null
      or p_resolution->>'callId' <> p_call_id
      or p_resolution->>'decision' not in ('approved', 'rejected')) then
    raise exception 'INTERACTION_RESOLUTION_INVALID' using errcode = '22023';
  end if;
  if p_interaction_type = 'user_input'
    and (nullif(trim(p_resolution->>'messageId'), '') is null
      or nullif(trim(p_resolution->>'text'), '') is null) then
    raise exception 'INTERACTION_RESOLUTION_INVALID' using errcode = '22023';
  end if;

  select * into v_run
  from public.agent_runs
  where id = p_run_id and owner_user_id = v_owner
  for update;
  if not found then raise exception 'RUN_NOT_FOUND' using errcode = 'P0002'; end if;

  v_checkpoint := coalesce(v_run.state->'loopCheckpoint', '{}'::jsonb);
  v_pending := v_checkpoint->'pendingInteraction';
  if v_pending is null or v_pending = 'null'::jsonb then
    if p_interaction_type = 'approval'
      and v_checkpoint->'pendingResolution'->>'interactionId' = p_interaction_id
      and v_checkpoint->'pendingResolution'->>'type' = 'approval'
      and v_checkpoint->'pendingResolution'->>'callId' = p_call_id
      and v_checkpoint->'pendingResolution'->>'decision' = p_resolution->>'decision' then
      return v_checkpoint;
    end if;
    if p_interaction_type = 'user_input'
      and v_checkpoint->'pendingResolution'->>'interactionId' = p_interaction_id
      and v_checkpoint->'pendingResolution'->>'type' = 'user_input'
      and v_checkpoint->'pendingResolution'->>'messageId' = p_resolution->>'messageId'
      and v_checkpoint->'pendingResolution'->>'text' = p_resolution->>'text' then
      return v_checkpoint;
    end if;
    raise exception 'INTERACTION_ALREADY_CLAIMED' using errcode = '40001';
  end if;
  if v_pending->>'interactionId' <> p_interaction_id
    or v_pending->>'type' <> p_interaction_type
    or (p_interaction_type = 'approval' and v_pending->>'callId' <> p_call_id) then
    raise exception 'INTERACTION_MISMATCH' using errcode = '40001';
  end if;

  if p_interaction_type = 'approval' then
    v_resolution := jsonb_build_object(
      'interactionId', p_interaction_id,
      'type', 'approval',
      'callId', v_pending->>'callId',
      'toolName', v_pending->>'toolName',
      'input', v_pending->'input',
      'decision', p_resolution->>'decision'
    );
  else
    v_resolution := p_resolution;
  end if;

  v_next_checkpoint := jsonb_set(v_checkpoint, '{pendingInteraction}', 'null'::jsonb, true);
  v_next_checkpoint := jsonb_set(v_next_checkpoint, '{pendingResolution}', v_resolution, true);
  v_next_checkpoint := jsonb_set(v_next_checkpoint, '{status}', '"running"'::jsonb, true);

  update public.agent_runs
  set state = jsonb_set(state, '{loopCheckpoint}', v_next_checkpoint, true)
              || jsonb_build_object('pendingInteraction', null, 'pendingResolution', v_resolution, 'status', 'running'),
      resume_cursor = v_next_checkpoint,
      status = 'running',
      lock_version = lock_version + 1,
      lease_expires_at = now() + interval '2 minutes',
      updated_at = now()
  where id = p_run_id and owner_user_id = v_owner;

  return v_next_checkpoint;
end;
$$;

revoke all on function public.resolve_agent_loop_interaction(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.resolve_agent_loop_interaction(uuid, text, text, text, jsonb) to authenticated;
