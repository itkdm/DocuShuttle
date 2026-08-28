-- Keep runtime versions owned by the executor that observed them. Assistant
-- message identity is immutable once written; retries may reuse it, but may
-- never rewrite its semantic text or run identity.

create or replace function public.commit_agent_checkpoint_with_message(
  p_run_id uuid,
  p_expected_lock_version bigint,
  p_checkpoint jsonb,
  p_message_key text,
  p_message_text text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_run public.agent_runs%rowtype;
  v_conversation uuid;
  v_existing_run uuid;
  v_existing_text text;
  v_status text;
  v_next_version bigint;
  v_state jsonb;
begin
  if v_owner is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '28000'; end if;
  if p_checkpoint is null or nullif(trim(p_message_key), '') is null or p_message_text is null then
    raise exception 'ASSISTANT_MESSAGE_INVALID' using errcode = '22023';
  end if;
  select * into v_run from public.agent_runs
    where id = p_run_id and owner_user_id = v_owner for update;
  if not found then raise exception 'RUN_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_run.status = 'cancelled' then raise exception 'RUN_CANCELLED' using errcode = '40001'; end if;
  if v_run.lock_version <> p_expected_lock_version then raise exception 'RUN_VERSION_CONFLICT' using errcode = '40001'; end if;

  v_status := case
    when p_checkpoint->>'status' in ('completed', 'failed', 'cancelled', 'awaiting_approval', 'awaiting_user') then p_checkpoint->>'status'
    else 'running'
  end;
  if v_status = 'cancelled' then raise exception 'RUN_CANCELLED' using errcode = '40001'; end if;
  v_conversation := nullif(v_run.state->>'conversationId', '')::uuid;
  if v_conversation is null then raise exception 'CONVERSATION_NOT_FOUND' using errcode = 'P0002'; end if;

  select m.run_id, m.parts->0->>'text' into v_existing_run, v_existing_text
  from public.messages m
  where m.conversation_id = v_conversation and m.message_key = p_message_key;
  if found then
    if v_existing_run is distinct from p_run_id or v_existing_text is distinct from p_message_text then
      raise exception 'ASSISTANT_MESSAGE_CONFLICT' using errcode = '40001';
    end if;
  else
    insert into public.messages(id, owner_user_id, conversation_id, role, parts, run_id, message_key, delivery_status)
      values (gen_random_uuid(), v_owner, v_conversation, 'assistant',
        jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_message_text)),
        p_run_id, p_message_key, 'sent');
  end if;

  v_next_version := v_run.lock_version + 1;
  v_state := coalesce(v_run.state, '{}'::jsonb) || jsonb_build_object(
    'version', v_next_version, 'status', v_status, 'loopCheckpoint', p_checkpoint,
    'pendingInteraction', coalesce(p_checkpoint->'pendingInteraction', 'null'::jsonb),
    'pendingResolution', coalesce(p_checkpoint->'pendingResolution', 'null'::jsonb));
  if v_status = 'failed' then
    v_state := v_state || jsonb_build_object('failure', jsonb_build_object(
      'code', 'AGENT_LOOP_FAILED', 'message', coalesce(p_checkpoint->>'finalText', 'Agent execution failed'), 'retryable', true));
  else v_state := v_state - 'failure'; end if;

  update public.agent_runs set state = v_state, status = v_status, resume_cursor = p_checkpoint,
    lock_version = v_next_version, updated_at = now(),
    lease_expires_at = case when v_status in ('queued', 'running') then now() + interval '2 minutes' else null end
    where id = p_run_id and owner_user_id = v_owner and lock_version = p_expected_lock_version;
  if not found then raise exception 'RUN_VERSION_CONFLICT' using errcode = '40001'; end if;
  return jsonb_build_object('checkpoint', p_checkpoint, 'lockVersion', v_next_version);
end;
$$;

create or replace function public.claim_agent_run_recovery(p_run_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_run public.agent_runs%rowtype; v_next_version bigint;
begin
  select * into v_run from public.agent_runs where id = p_run_id and owner_user_id = v_owner for update;
  if not found then raise exception 'RUN_NOT_FOUND'; end if;
  if v_run.status <> 'running' then return null; end if;
  if v_run.lease_expires_at is not null and v_run.lease_expires_at > now() then raise exception 'RUN_STILL_ACTIVE'; end if;
  v_next_version := v_run.lock_version + 1;
  update public.agent_runs set lease_expires_at = now() + interval '2 minutes', lock_version = v_next_version, updated_at = now()
    where id = p_run_id and owner_user_id = v_owner;
  return jsonb_build_object('checkpoint', v_run.state->'loopCheckpoint', 'lockVersion', v_next_version);
end;
$$;

create or replace function public.resolve_agent_loop_interaction(
  p_run_id uuid, p_interaction_id text, p_interaction_type text,
  p_call_id text default null, p_resolution jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_run public.agent_runs%rowtype; v_checkpoint jsonb; v_pending jsonb; v_resolution jsonb; v_next jsonb;
begin
  if p_interaction_type not in ('approval', 'user_input') then raise exception 'INTERACTION_TYPE_INVALID'; end if;
  if p_resolution->>'interactionId' <> p_interaction_id or p_resolution->>'type' <> p_interaction_type then raise exception 'INTERACTION_RESOLUTION_INVALID'; end if;
  if p_interaction_type = 'approval' and (p_resolution->>'callId' is null or p_resolution->>'callId' <> p_call_id or p_resolution->>'decision' not in ('approved', 'rejected')) then raise exception 'INTERACTION_RESOLUTION_INVALID'; end if;
  if p_interaction_type = 'user_input' and (nullif(trim(p_resolution->>'messageId'), '') is null or nullif(trim(p_resolution->>'text'), '') is null) then raise exception 'INTERACTION_RESOLUTION_INVALID'; end if;
  select * into v_run from public.agent_runs where id = p_run_id and owner_user_id = v_owner for update;
  if not found then raise exception 'RUN_NOT_FOUND'; end if;
  v_checkpoint := coalesce(v_run.state->'loopCheckpoint', '{}'::jsonb); v_pending := v_checkpoint->'pendingInteraction';
  if v_pending is null or v_pending = 'null'::jsonb then
    if p_interaction_type = 'approval' and v_checkpoint->'pendingResolution'->>'interactionId' = p_interaction_id and v_checkpoint->'pendingResolution'->>'callId' = p_call_id and v_checkpoint->'pendingResolution'->>'decision' = p_resolution->>'decision' then
      return jsonb_build_object('checkpoint', v_checkpoint, 'lockVersion', v_run.lock_version);
    end if;
    if p_interaction_type = 'user_input' and v_checkpoint->'pendingResolution'->>'interactionId' = p_interaction_id and v_checkpoint->'pendingResolution'->>'messageId' = p_resolution->>'messageId' and v_checkpoint->'pendingResolution'->>'text' = p_resolution->>'text' then
      return jsonb_build_object('checkpoint', v_checkpoint, 'lockVersion', v_run.lock_version);
    end if;
    raise exception 'INTERACTION_ALREADY_CLAIMED';
  end if;
  if v_pending->>'interactionId' <> p_interaction_id or v_pending->>'type' <> p_interaction_type or (p_interaction_type = 'approval' and v_pending->>'callId' <> p_call_id) then raise exception 'INTERACTION_MISMATCH'; end if;
  v_resolution := case when p_interaction_type = 'approval' then jsonb_build_object('interactionId', p_interaction_id, 'type', 'approval', 'callId', v_pending->>'callId', 'toolName', v_pending->>'toolName', 'input', v_pending->'input', 'decision', p_resolution->>'decision') else p_resolution end;
  v_next := jsonb_set(jsonb_set(jsonb_set(v_checkpoint, '{pendingInteraction}', 'null'::jsonb, true), '{pendingResolution}', v_resolution, true), '{status}', '"running"'::jsonb, true);
  update public.agent_runs set state = jsonb_set(state, '{loopCheckpoint}', v_next, true) || jsonb_build_object('pendingInteraction', null, 'pendingResolution', v_resolution, 'status', 'running'), resume_cursor = v_next, status = 'running', lock_version = lock_version + 1, lease_expires_at = now() + interval '2 minutes', updated_at = now() where id = p_run_id and owner_user_id = v_owner;
  return jsonb_build_object('checkpoint', v_next, 'lockVersion', v_run.lock_version + 1);
end;
$$;

revoke all on function public.commit_agent_checkpoint_with_message(uuid, bigint, jsonb, text, text) from public, anon;
grant execute on function public.commit_agent_checkpoint_with_message(uuid, bigint, jsonb, text, text) to authenticated;
revoke all on function public.claim_agent_run_recovery(uuid) from public;
grant execute on function public.claim_agent_run_recovery(uuid) to authenticated;
revoke all on function public.resolve_agent_loop_interaction(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.resolve_agent_loop_interaction(uuid, text, text, text, jsonb) to authenticated;
