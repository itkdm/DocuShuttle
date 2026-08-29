-- Durable browser-owned tool rendezvous. Client tools never execute in the
-- runtime process; the run pauses until an authenticated browser returns a
-- validated, metadata-only result.

alter table public.agent_runs drop constraint if exists agent_runs_status_check;
alter table public.agent_runs add constraint agent_runs_status_check
  check (status in ('queued', 'running', 'awaiting_approval', 'awaiting_user', 'awaiting_client', 'completed', 'failed', 'cancelled'));

drop index if exists public.agent_runs_one_active_per_task_idx;
create unique index agent_runs_one_active_per_task_idx
  on public.agent_runs(task_id)
  where status in ('queued', 'running', 'awaiting_approval', 'awaiting_user', 'awaiting_client');

drop index if exists public.agent_runs_status_idx;
create index agent_runs_status_idx on public.agent_runs(status)
  where status in ('queued', 'running', 'awaiting_approval', 'awaiting_user', 'awaiting_client');

create or replace function public.save_agent_loop_checkpoint(
  p_run_id uuid,
  p_expected_lock_version bigint,
  p_checkpoint jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_run public.agent_runs%rowtype;
  v_status text;
  v_next_version bigint;
  v_state jsonb;
  v_lease_expires_at timestamptz;
begin
  if v_owner is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000'; end if;
  if p_checkpoint is null then raise exception 'CHECKPOINT_INVALID' using errcode = '22023'; end if;
  select * into v_run from public.agent_runs where id = p_run_id and owner_user_id = v_owner for update;
  if not found then raise exception 'RUN_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_run.status = 'cancelled' then raise exception 'RUN_CANCELLED' using errcode = '40001'; end if;
  if v_run.lock_version <> p_expected_lock_version then raise exception 'RUN_VERSION_CONFLICT' using errcode = '40001'; end if;
  v_status := case when p_checkpoint->>'status' in ('completed', 'failed', 'cancelled', 'awaiting_approval', 'awaiting_user', 'awaiting_client') then p_checkpoint->>'status' else 'running' end;
  if v_status = 'cancelled' then raise exception 'RUN_CANCELLED' using errcode = '40001'; end if;
  v_next_version := v_run.lock_version + 1;
  v_lease_expires_at := case when v_status in ('queued', 'running') then now() + interval '2 minutes' else null end;
  v_state := coalesce(v_run.state, '{}'::jsonb) || jsonb_build_object(
    'version', v_next_version, 'status', v_status, 'loopCheckpoint', p_checkpoint,
    'pendingInteraction', coalesce(p_checkpoint->'pendingInteraction', 'null'::jsonb),
    'pendingResolution', coalesce(p_checkpoint->'pendingResolution', 'null'::jsonb));
  if v_status = 'failed' then
    v_state := v_state || jsonb_build_object('failure', jsonb_build_object('code', 'AGENT_LOOP_FAILED', 'message', coalesce(p_checkpoint->>'finalText', 'Agent execution failed'), 'retryable', true));
  else v_state := v_state - 'failure'; end if;
  update public.agent_runs set state = v_state, status = v_status, resume_cursor = p_checkpoint,
    lock_version = v_next_version, updated_at = now(), lease_expires_at = v_lease_expires_at
    where id = p_run_id and owner_user_id = v_owner and lock_version = p_expected_lock_version and status <> 'cancelled';
  if not found then raise exception 'RUN_VERSION_CONFLICT' using errcode = '40001'; end if;
  return jsonb_build_object('lockVersion', v_next_version, 'checkpoint', p_checkpoint);
end;
$$;

create or replace function public.resolve_agent_loop_interaction(
  p_run_id uuid, p_interaction_id text, p_interaction_type text,
  p_call_id text default null, p_resolution jsonb default '{}'::jsonb
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
  v_next jsonb;
begin
  if p_interaction_type not in ('approval', 'user_input', 'client_tool') then raise exception 'INTERACTION_TYPE_INVALID'; end if;
  if p_resolution->>'interactionId' <> p_interaction_id or p_resolution->>'type' <> p_interaction_type then raise exception 'INTERACTION_RESOLUTION_INVALID'; end if;
  if p_interaction_type = 'approval' and (p_resolution->>'callId' is null or p_resolution->>'callId' <> p_call_id or p_resolution->>'decision' not in ('approved', 'rejected')) then raise exception 'INTERACTION_RESOLUTION_INVALID'; end if;
  if p_interaction_type = 'user_input' and (nullif(trim(p_resolution->>'messageId'), '') is null or nullif(trim(p_resolution->>'text'), '') is null) then raise exception 'INTERACTION_RESOLUTION_INVALID'; end if;
  if p_interaction_type = 'client_tool' and (
    p_resolution->>'callId' is null or p_resolution->>'callId' <> p_call_id
    or jsonb_typeof(p_resolution->'result') <> 'object'
    or p_resolution->'result'->>'assetId' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    or p_resolution->'result'->>'mimeType' <> 'image/png'
    or p_resolution->'result'->>'sha256' !~ '^[0-9a-f]{64}$'
    or nullif(p_resolution->'result'->>'revision', '') is null
    or p_resolution->'result'->>'width' !~ '^[1-9][0-9]{0,4}$'
    or p_resolution->'result'->>'height' !~ '^[1-9][0-9]{0,4}$'
  ) then raise exception 'CLIENT_TOOL_RESULT_INVALID' using errcode = '22023'; end if;

  select * into v_run from public.agent_runs where id = p_run_id and owner_user_id = v_owner for update;
  if not found then raise exception 'RUN_NOT_FOUND'; end if;
  if v_run.status = 'cancelled' then raise exception 'RUN_CANCELLED' using errcode = '40001'; end if;
  v_checkpoint := coalesce(v_run.state->'loopCheckpoint', '{}'::jsonb);
  v_pending := v_checkpoint->'pendingInteraction';
  if v_pending is null or v_pending = 'null'::jsonb then
    if p_interaction_type = 'client_tool' and v_checkpoint->'pendingResolution'->>'interactionId' = p_interaction_id and v_checkpoint->'pendingResolution'->>'callId' = p_call_id and v_checkpoint->'pendingResolution'->'result' = p_resolution->'result' then
      return jsonb_build_object('checkpoint', v_checkpoint, 'lockVersion', v_run.lock_version);
    end if;
    raise exception 'INTERACTION_ALREADY_CLAIMED';
  end if;
  if p_interaction_type = 'client_tool' and (v_pending->'input'->>'expectedRevision' is null or p_resolution->'result'->>'revision' <> v_pending->'input'->>'expectedRevision') then
    raise exception 'CLIENT_TOOL_REVISION_MISMATCH' using errcode = '40001';
  end if;
  if v_pending->>'interactionId' <> p_interaction_id or v_pending->>'type' <> p_interaction_type or (p_interaction_type in ('approval', 'client_tool') and v_pending->>'callId' <> p_call_id) then raise exception 'INTERACTION_MISMATCH'; end if;
  v_resolution := case
    when p_interaction_type = 'approval' then jsonb_build_object('interactionId', p_interaction_id, 'type', 'approval', 'callId', v_pending->>'callId', 'toolName', v_pending->>'toolName', 'input', v_pending->'input', 'decision', p_resolution->>'decision')
    when p_interaction_type = 'client_tool' then jsonb_build_object('interactionId', p_interaction_id, 'type', 'client_tool', 'callId', v_pending->>'callId', 'toolName', v_pending->>'toolName', 'input', v_pending->'input', 'result', p_resolution->'result')
    else p_resolution
  end;
  v_next := jsonb_set(jsonb_set(jsonb_set(v_checkpoint, '{pendingInteraction}', 'null'::jsonb, true), '{pendingResolution}', v_resolution, true), '{status}', '"running"'::jsonb, true);
  update public.agent_runs set state = jsonb_set(state, '{loopCheckpoint}', v_next, true) || jsonb_build_object('pendingInteraction', null, 'pendingResolution', v_resolution, 'status', 'running'), resume_cursor = v_next, status = 'running', lock_version = lock_version + 1, lease_expires_at = now() + interval '2 minutes', updated_at = now() where id = p_run_id and owner_user_id = v_owner;
  return jsonb_build_object('checkpoint', v_next, 'lockVersion', v_run.lock_version + 1);
end;
$$;

revoke all on function public.save_agent_loop_checkpoint(uuid, bigint, jsonb) from public, anon;
grant execute on function public.save_agent_loop_checkpoint(uuid, bigint, jsonb) to authenticated;
revoke all on function public.resolve_agent_loop_interaction(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.resolve_agent_loop_interaction(uuid, text, text, text, jsonb) to authenticated;
